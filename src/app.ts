import { LatchwayError } from "@latchway/client";
import { DefaultLatchwayClient } from "./client.js";
import { nativeModule, type NativeLatchwayModule } from "./native/bridge.js";
import { assertNoCredentialFields } from "./native-output.js";
import type { AndroidSecurityOptions, AppleSecurityOptions, LatchwayClient, ReactNativeIOSComponent, ReactNativePlatform } from "./types.js";
import { SDK_VERSION } from "./version.js";
import { fromNativeError, LatchwayLifecycleError } from "./errors.js";

export interface LatchwayAppOptions {
  baseURL: string;
  applicationID: string;
  environment: string;
  identity?: { name: string; issuer: string; tenant?: string };
  identityProvider?: string;
  apple?: Partial<AppleSecurityOptions> & {
    /** Authorized delegated-component groups, distinct from the private root. */
    sharedKeychainAccessGroups?: readonly string[];
    /** Explicit [] declares no historical delegated component credentials. */
    legacyComponents?: readonly ReactNativeIOSComponent[];
    legacyAttestationNamespaces?: readonly string[];
  };
  android?: Partial<AndroidSecurityOptions>;
  /** Standalone JS-owned auth: return one user's issuer/tenant/UID/token atomically. */
  getIdentitySnapshot?: () => Promise<LatchwayIdentitySnapshot | null>;
}

export interface LatchwayIdentitySnapshot {
  issuer: string;
  tenant?: string;
  subject: string;
  token: string;
}

export interface LatchwayAppSnapshot {
  appInstanceID: string;
  authorityInstanceID: string;
  generationID?: string;
  revision: number;
  state: "inactive" | "active" | "retiring" | "loggedOut";
}

interface AppDescriptor extends LatchwayAppSnapshot {
  nativeAppABI: 1;
  contractVersion: "1.1.0";
  protocolVersion: 3;
  baseURL: string;
  applicationID: string;
  environment: string;
  nativeSDKVersion: string;
  platform: ReactNativePlatform;
  authorityInstanceID: string;
  componentKeychainAccessGroups?: readonly string[];
}

let nextClient = 0;
const wrapperID = Math.random().toString(36).slice(2);
interface IdentityOwner {
  id: string;
  provider: () => Promise<LatchwayIdentitySnapshot | null>;
  running: boolean;
}
const identityOwners = new WeakMap<NativeLatchwayModule, Map<string, Promise<IdentityOwner>>>();

/** A wrapper for the process-wide native app, not a JavaScript session owner. */
export class LatchwayApp {
  readonly name: string;
  readonly instanceID: string;
  readonly gatewayURL: string;
  private latest: AppDescriptor;

  /** @internal Use configureLatchwayApp/getLatchwayApp. */
  constructor(name: string, private readonly module: NativeLatchwayModule, descriptor: AppDescriptor) {
    this.name = name;
    this.instanceID = descriptor.appInstanceID;
    this.gatewayURL = descriptor.baseURL.replace(/\/$/u, "");
    this.latest = descriptor;
  }

  async snapshot(): Promise<LatchwayAppSnapshot> {
    return this.accept(await command(this.module, { operation: "snapshot", name: this.name }));
  }

  /** Explicit activation through the one registered identity authority. */
  async activate(): Promise<LatchwayAppSnapshot> {
    return this.accept(await command(this.module, { operation: "activate", name: this.name }));
  }

  /** Requires a captured generation. Never guesses the current/new account. */
  async logout(generationID: string): Promise<void> {
    this.accept(await command(this.module, { operation: "logout", name: this.name, generationID }));
  }

  /** Explicitly retire the current account and replace its auth owner. Useful
   * after a standalone JS reload; never call this from an ordinary remount.
   * Read a snapshot and supply its owner ID to reject stale competing transfers.
   * Activation is a separate, intentional login action after this completes. */
  async transferIdentityAuthority(options: {
    identity: NonNullable<LatchwayAppOptions["identity"]>;
    getIdentitySnapshot: NonNullable<LatchwayAppOptions["getIdentitySnapshot"]>;
    expectedAuthorityInstanceID: string;
  }): Promise<LatchwayAppSnapshot> {
    const owner = await createIdentityOwner(this.module, options.getIdentitySnapshot);
    const descriptor = await command(this.module, { operation: "transferIdentityAuthority", name: this.name,
      identity: options.identity, authorityInstanceID: owner.id,
      expectedAuthorityInstanceID: options.expectedAuthorityInstanceID });
    const snapshot = this.accept(descriptor);
    if (snapshot.authorityInstanceID !== owner.id) throw invalidResponse();
    let owners = identityOwners.get(this.module);
    if (owners === undefined) { owners = new Map(); identityOwners.set(this.module, owners); }
    owners.set(identityOwnerKey({ ...options, baseURL: descriptor.baseURL,
      applicationID: descriptor.applicationID, environment: descriptor.environment }), Promise.resolve(owner));
    startIdentityOwner(this.module, owner);
    return snapshot;
  }

  async makeClient(): Promise<LatchwayClient> {
    const clientID = `latchway-app-${wrapperID}-${++nextClient}`;
    try {
      const descriptor = await command(this.module, { operation: "client", name: this.name, clientID, sdkVersion: SDK_VERSION });
      this.accept(descriptor);
      if (descriptor.state !== "active" || descriptor.generationID === undefined) {
        throw new LatchwayLifecycleError("client_logged_out", "Activate the native app account before creating a client.");
      }
      let released = false;
      const lease = Promise.resolve({
        clientID, module: this.module,
        ready: Promise.resolve({ platform: descriptor.platform, nativeSDKVersion: descriptor.nativeSDKVersion,
          contractVersion: descriptor.contractVersion, protocolVersion: descriptor.protocolVersion }),
        release: async () => {
          if (released) return;
          released = true;
          await this.module.dispose(clientID);
        },
      });
      return new DefaultLatchwayClient({
        baseURL: new URL(`${descriptor.baseURL.replace(/\/$/u, "")}/`),
        applicationID: descriptor.applicationID, environment: descriptor.environment,
        identityProvider: "native-owned", appVersion: SDK_VERSION, nativeIdentityAuthority: true,
        getIdentityToken: () => Promise.reject(new LatchwayLifecycleError("identity_authority_required", "Identity belongs to the native app.")),
        appleSharedKeychainAccessGroups: descriptor.componentKeychainAccessGroups ?? [], nativeJSON: "", fingerprint: descriptor.appInstanceID,
        scope: `${descriptor.appInstanceID}|${descriptor.generationID}`,
      }, lease);
    } catch (error) {
      await this.module.dispose(clientID).catch(() => undefined);
      throw error;
    }
  }

  /** Ordered native snapshots. Enforcement never depends on collecting events. */
  async *states(signal?: AbortSignal): AsyncGenerator<LatchwayAppSnapshot> {
    yield await this.snapshot();
    while (!signal?.aborted) {
      const afterRevision = this.latest.revision;
      const next = await command(this.module, { operation: "observe", name: this.name, afterRevision });
      if (signal?.aborted) return;
      const accepted = this.accept(next);
      if (accepted.revision > afterRevision) yield accepted;
    }
  }

  private accept(value: AppDescriptor): LatchwayAppSnapshot {
    if (value.appInstanceID !== this.instanceID) {
      throw new LatchwayError("client_configuration_invalid", "The native app instance changed; retrieve a fresh handle.");
    }
    if (value.revision >= this.latest.revision) this.latest = value;
    return publicSnapshot(this.latest);
  }
}

/** Matching native configuration is a no-op; omitted settings inherit it. */
export async function configureLatchwayApp(options: LatchwayAppOptions, name = "[DEFAULT]"): Promise<LatchwayApp> {
  const module = await nativeModule();
  requireAppModule(module);
  const { getIdentitySnapshot, ...publicOptions } = options;
  let owners = identityOwners.get(module);
  if (owners === undefined) { owners = new Map(); identityOwners.set(module, owners); }
  const ownerKey = identityOwnerKey(options);
  let pendingOwner = owners.get(ownerKey);
  if (pendingOwner === undefined && getIdentitySnapshot !== undefined) {
    if (options.identity === undefined) throw new LatchwayLifecycleError("identity_authority_required");
    // Publish the promise before awaiting native, so concurrent configure calls
    // cannot register competing owners or replace the first callback.
    pendingOwner = createIdentityOwner(module, getIdentitySnapshot);
    owners.set(ownerKey, pendingOwner);
  }
  let owner: IdentityOwner | undefined;
  try { owner = await pendingOwner; } catch (error) { owners.delete(ownerKey); throw error; }
  let descriptor: AppDescriptor;
  try {
    descriptor = await command(module, { ...publicOptions, operation: "configure", name,
      ...(owner === undefined ? {} : { authorityInstanceID: owner.id }) });
  } catch (error) {
    // A failed first initialization must not pin an unregistered JS callback.
    // Do not delete a newer owner's promise installed by an explicit transfer.
    if (owners.get(ownerKey) === pendingOwner) owners.delete(ownerKey);
    throw error;
  }
  if (owner !== undefined && owner.id === descriptor.authorityInstanceID) startIdentityOwner(module, owner);
  return new LatchwayApp(name, module, descriptor);
}

function identityOwnerKey(options: LatchwayAppOptions): string {
  return JSON.stringify([new URL(options.baseURL).href.replace(/\/$/u, ""), options.applicationID,
    options.environment, options.identity?.name, options.identity?.issuer, options.identity?.tenant]);
}

function startIdentityOwner(module: NativeLatchwayModule, owner: IdentityOwner): void {
  if (owner.running) return;
  owner.running = true;
  void serveIdentity(module, owner).finally(() => { owner.running = false; });
}

async function createIdentityOwner(module: NativeLatchwayModule, provider: IdentityOwner["provider"]): Promise<IdentityOwner> {
  const encoded = await module.appCommand(JSON.stringify({ operation: "newIdentityAuthority" }))
    .catch((error: unknown) => { throw fromNativeError(error); });
  let handle: unknown;
  try { handle = JSON.parse(encoded); } catch { throw invalidResponse(); }
  if (typeof handle !== "object" || handle === null || Array.isArray(handle) ||
      Object.keys(handle).length !== 1 || !("authorityInstanceID" in handle) ||
      typeof handle.authorityInstanceID !== "string" || !UUID.test(handle.authorityInstanceID)) throw invalidResponse();
  return { id: handle.authorityInstanceID, provider, running: false };
}

async function serveIdentity(module: NativeLatchwayModule, owner: {
  id: string; provider: () => Promise<LatchwayIdentitySnapshot | null>;
}): Promise<void> {
  // Native limits each identity wait to 15 seconds. If this JS runtime goes
  // away or its provider stalls, native authorization fails closed.
  try {
    while (true) {
      const encoded = await module.appCommand(JSON.stringify({ operation: "identityPoll", authorityInstanceID: owner.id }));
      if (encoded.length > 1024) return;
      const request = JSON.parse(encoded) as { requestID?: unknown };
      if (typeof request !== "object" || request === null || Array.isArray(request) ||
          Object.keys(request).some((key) => key !== "requestID")) return;
      if (request.requestID === undefined) continue;
      if (typeof request.requestID !== "string" || !UUID.test(request.requestID)) return;
      let snapshot: LatchwayIdentitySnapshot | null;
      try { snapshot = await owner.provider(); } catch { snapshot = null; }
      await module.appCommand(JSON.stringify({ operation: "identityReply", authorityInstanceID: owner.id,
        requestID: request.requestID, snapshot }));
    }
  } catch {
    // Bridge invalidation terminates the owner loop. Native session checks
    // still enforce their timeout and never reuse a previous identity token.
  }
}

export async function getLatchwayApp(name = "[DEFAULT]"): Promise<LatchwayApp> {
  const module = await nativeModule();
  return new LatchwayApp(name, module, await command(module, { operation: "get", name }));
}

export const Latchway = { configure: configureLatchwayApp, getApp: getLatchwayApp } as const;

async function command(module: NativeLatchwayModule, input: Record<string, unknown>): Promise<AppDescriptor> {
  requireAppModule(module);
  const encoded = await module.appCommand(JSON.stringify(input)).catch((error: unknown) => { throw fromNativeError(error); });
  if (encoded.length > 131_072) throw invalidResponse();
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw invalidResponse(); }
  assertNoCredentialFields(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidResponse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !DESCRIPTOR_KEYS.has(key))) throw invalidResponse();
  if (record.componentKeychainAccessGroups !== undefined &&
      (!Array.isArray(record.componentKeychainAccessGroups) || record.componentKeychainAccessGroups.length > 256 ||
       new Set(record.componentKeychainAccessGroups).size !== record.componentKeychainAccessGroups.length ||
       record.componentKeychainAccessGroups.some(group => typeof group !== "string" || group.length > 255 ||
         !/^[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+$/u.test(group)))) throw invalidResponse();
  if (record.nativeAppABI !== 1 || record.contractVersion !== "1.1.0" || record.protocolVersion !== 3 ||
      !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 ||
      !["inactive", "active", "retiring", "loggedOut"].includes(record.state as string) ||
      !["react_native_ios", "react_native_android"].includes(record.platform as string) ||
      ["baseURL", "applicationID", "environment", "nativeSDKVersion", "appInstanceID", "authorityInstanceID"]
        .some((key) => typeof record[key] !== "string" || !record[key].length || record[key].length > 2048) ||
      !UUID.test(record.appInstanceID as string) || !UUID.test(record.authorityInstanceID as string) ||
      record.generationID !== undefined && (typeof record.generationID !== "string" || !UUID.test(record.generationID)) ||
      record.state === "active" && record.generationID === undefined) throw invalidResponse();
  let url: URL;
  try { url = new URL(record.baseURL as string); } catch { throw invalidResponse(); }
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || /%2f|%5c|%2e|\/\//iu.test(url.pathname)) throw invalidResponse();
  return record as unknown as AppDescriptor;
}

function requireAppModule(module: NativeLatchwayModule): void {
  if (typeof module.appCommand !== "function") {
    throw new LatchwayLifecycleError("native_version_incompatible", "Rebuild with the shared native app SDKs.");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DESCRIPTOR_KEYS = new Set(["nativeAppABI", "contractVersion", "protocolVersion", "revision", "state", "platform",
  "baseURL", "applicationID", "environment", "nativeSDKVersion", "appInstanceID", "authorityInstanceID", "generationID", "componentKeychainAccessGroups"]);

function publicSnapshot(value: AppDescriptor): LatchwayAppSnapshot {
  return { appInstanceID: value.appInstanceID, authorityInstanceID: value.authorityInstanceID,
    revision: value.revision, state: value.state,
    ...(value.generationID === undefined ? {} : { generationID: value.generationID }) };
}

function invalidResponse(): LatchwayError {
  return new LatchwayError("protocol_response_invalid", "The native shared-app response is incompatible.");
}

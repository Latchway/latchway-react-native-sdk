import { LatchwayError } from "@latchway/client";
import { DefaultLatchwayClient } from "./client.js";
import { nativeModule, type NativeLatchwayModule } from "./native/bridge.js";
import { assertNoCredentialFields } from "./native-output.js";
import type { AndroidSecurityOptions, AppleSecurityOptions, LatchwayClient, ReactNativeIOSComponent, ReactNativePlatform } from "./types.js";
import { SDK_VERSION } from "./version.js";
import { abortError, fromNativeError, LatchwayLifecycleError } from "./errors.js";
import { validateIdentityConfiguration, type LatchwayIdentityConfiguration } from "./identity.js";

export interface LegacyIdentityReference { name: string; issuer: string; tenant?: string }

/** Application-owned token acquisition; never retained as a shared JS provider. */
export type LatchwayTokenInput = ({ idToken: string; getIdToken?: never } |
  { getIdToken: () => Promise<string>; idToken?: never }) & { signal?: AbortSignal };

export interface LatchwayAppOptions {
  baseURL: string;
  applicationID: string;
  environment: string;
  identity?: LatchwayIdentityConfiguration | LegacyIdentityReference;
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
  state: "inactive" | "active" | "refreshRequired" | "retiring" | "loggedOut";
}

interface AppDescriptor extends LatchwayAppSnapshot {
  nativeAppABI: 1 | 2;
  identityMode?: "supplied" | "authority";
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

interface PendingIdentity {
  controller: AbortController;
  finished: Promise<void>;
  cleanupFailure?: { reason: unknown };
}
interface AppIdentityWork {
  pending: Set<PendingIdentity>;
  signOut?: Promise<AppDescriptor>;
}
const identityWork = new WeakMap<NativeLatchwayModule, Map<string, AppIdentityWork>>();

function workFor(module: NativeLatchwayModule, appInstanceID: string): AppIdentityWork {
  let apps = identityWork.get(module);
  if (apps === undefined) { apps = new Map(); identityWork.set(module, apps); }
  let work = apps.get(appInstanceID);
  if (work === undefined) { work = { pending: new Set() }; apps.set(appInstanceID, work); }
  return work;
}

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

  /** Verify an application's ID token and join/create its shared native account. */
  async signIn(input: LatchwayTokenInput): Promise<LatchwayAccount> {
    return this.identityOperation("signIn", input);
  }

  /** Restore existing auth without overriding a durable Latchway logout. */
  async restore(input: LatchwayTokenInput): Promise<LatchwayAccount> {
    return this.identityOperation("restore", input);
  }

  /** Sign out this app's shared native/RN account, including pending sign-in or
   * interrupted cleanup. Safe to repeat; await before accepting another login.
   * Does not sign out your authentication provider or reset server-side quotas.
   * A genuine secure-storage failure remains blocked and can be retried here. */
  async signOut(): Promise<void> {
    const minimumMinor = this.latest.platform === "react_native_ios" ? 3 : 2;
    const version = /^(\d+)\.(\d+)\.(\d+)$/u.exec(this.latest.nativeSDKVersion);
    if (this.latest.nativeAppABI !== 2 || version === null ||
        Number(version[1]) < 1 || Number(version[1]) === 1 && Number(version[2]) < minimumMinor) {
      throw new LatchwayLifecycleError("native_version_incompatible",
        "App signOut requires iOS SDK 1.3.0 or Android SDK 1.2.0. Reinstall native dependencies and rebuild the app.");
    }
    const work = workFor(this.module, this.instanceID);
    let flight = work.signOut;
    if (flight === undefined) {
      const pending = [...work.pending];
      for (const operation of pending) operation.controller.abort();
      flight = (async () => {
        // Native owns the durable barrier. Also settle this runtime's pending
        // acquisition promises without waiting for an application's token
        // producer that ignores cancellation. A delayed native ticket must be
        // cancelled before the caller is told sign-out has completed.
        const [result] = await Promise.allSettled([
          command(this.module, { operation: "signOut", name: this.name }),
          Promise.all(pending.map(operation => operation.finished)),
        ] as const);
        if (result.status === "rejected") throw result.reason;
        const failedCleanup = pending.find(operation => operation.cleanupFailure !== undefined)?.cleanupFailure;
        if (failedCleanup !== undefined) throw failedCleanup.reason;
        return result.value;
      })();
      work.signOut = flight;
    }
    try { this.accept(await flight); }
    finally { if (work.signOut === flight) delete work.signOut; }
  }

  /** Attach without signing in, acquiring a token, or changing account ownership. */
  async currentAccount(): Promise<LatchwayAccount | null> {
    this.requireSuppliedIdentity();
    const snapshot = await this.snapshot();
    return snapshot.generationID !== undefined && ["active", "refreshRequired"].includes(snapshot.state)
      ? new LatchwayAccount(this, snapshot.generationID) : null;
  }

  /** @internal Account handles call this with their captured generation. */
  async identityOperation(intent: "signIn" | "restore" | "update", input: LatchwayTokenInput,
    generationID?: string, bindingID?: string): Promise<LatchwayAccount> {
    const work = workFor(this.module, this.instanceID);
    if (work.signOut !== undefined) throw new LatchwayLifecycleError("cleanup_required");
    const controller = new AbortController();
    let finish: () => void = () => undefined;
    const pending: PendingIdentity = { controller, finished: new Promise(resolve => { finish = resolve; }) };
    const onAbort = (): void => { controller.abort(); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) controller.abort();
    work.pending.add(pending);
    try {
      return await this.performIdentityOperation(intent, { ...input, signal: controller.signal }, generationID, bindingID,
        reason => { pending.cleanupFailure = { reason }; });
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
      work.pending.delete(pending);
      finish();
    }
  }

  private async performIdentityOperation(intent: "signIn" | "restore" | "update", input: LatchwayTokenInput,
    generationID?: string, bindingID?: string, onCleanupFailure?: (reason: unknown) => void): Promise<LatchwayAccount> {
    this.requireSuppliedIdentity();
    if (input.signal?.aborted) throw abortError();
    if ((typeof input.idToken === "string") === (typeof input.getIdToken === "function")) {
      throw new LatchwayError("client_configuration_invalid", "Supply either idToken or getIdToken.");
    }
    // Capture native state before invoking application code. Cancellation during
    // begin is handled immediately when the opaque native ticket arrives.
    const ticketID = await beginIdentity(this.module, { operation: "beginIdentity", name: this.name, intent,
      ...(generationID === undefined ? {} : { generationID }),
      ...(bindingID === undefined ? {} : { bindingID }) });
    let cancellation: Promise<void> | undefined;
    const cancel = (): Promise<void> => {
      cancellation ??= command(this.module, { operation: "cancelIdentity", name: this.name, ticketID })
        .then(value => { this.accept(value); })
        .catch((error: unknown) => { onCleanupFailure?.(error); throw error; });
      return cancellation;
    };
    let rejectCancellation: (reason: unknown) => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => { rejectCancellation = reject; });
    const onAbort = (): void => { void cancel().then(() => rejectCancellation(abortError()), rejectCancellation); };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (input.signal?.aborted) { await cancel(); throw abortError(); }
      const work = (async (): Promise<LatchwayAccount> => {
        let idToken: string;
        try { idToken = input.getIdToken === undefined ? input.idToken : await input.getIdToken(); }
        catch { throw new LatchwayLifecycleError("identity_unavailable", "The application could not supply an ID token."); }
        if (input.signal?.aborted) throw abortError();
        if (typeof idToken !== "string" || idToken.length === 0 || idToken.length > 65_536 || /\s/u.test(idToken)) {
          throw new LatchwayError("identity_token_invalid", "The application supplied an invalid ID token.");
        }
        const descriptor = await command(this.module, { operation: "completeIdentity", name: this.name, ticketID, idToken });
        this.accept(descriptor);
        if (input.signal?.aborted) throw abortError();
        if (descriptor.state !== "active" || descriptor.generationID === undefined ||
            (generationID !== undefined && descriptor.generationID !== generationID) ||
            this.latest.generationID !== descriptor.generationID || this.latest.state !== "active") {
          throw new LatchwayLifecycleError("account_changed");
        }
        return new LatchwayAccount(this, descriptor.generationID);
      })();
      return await Promise.race([work, cancelled]);
    } catch (error) {
      // Cancelling invalidates native state, not just this JavaScript promise.
      await cancel();
      throw error;
    } finally {
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** @internal One native lease prevents competing injected auth subscriptions. */
  async claimIdentityBinding(): Promise<string> {
    this.requireSuppliedIdentity();
    return opaqueHandle(this.module, { operation: "claimIdentityBinding", name: this.name }, "bindingID");
  }

  /** @internal Release only this binding; never retire the shared account. */
  async releaseIdentityBinding(bindingID: string): Promise<void> {
    this.accept(await command(this.module, { operation: "releaseIdentityBinding", name: this.name, bindingID }));
  }

  private requireSuppliedIdentity(): void {
    if (this.latest.nativeAppABI !== 2) {
      throw new LatchwayLifecycleError("native_version_incompatible", "Rebuild with the supplied-identity native SDKs.");
    }
    if (this.latest.identityMode !== "supplied") {
      throw new LatchwayLifecycleError("configuration_conflict", "This app uses a legacy identity authority.");
    }
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
    identity: LegacyIdentityReference;
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

  async makeClient(generationID?: string): Promise<LatchwayClient> {
    const clientID = `latchway-app-${wrapperID}-${++nextClient}`;
    try {
      const before = await this.snapshot();
      const capturedGeneration = generationID ?? before.generationID;
      if (generationID !== undefined && before.generationID !== generationID) throw new LatchwayLifecycleError("account_changed");
      if (before.state === "refreshRequired") throw new LatchwayLifecycleError("identity_refresh_required");
      if (before.state !== "active" || capturedGeneration === undefined) throw new LatchwayLifecycleError("client_logged_out");
      const descriptor = await command(this.module, { operation: "client", name: this.name, clientID, sdkVersion: SDK_VERSION,
        generationID: capturedGeneration });
      this.accept(descriptor);
      if (descriptor.state !== "active" || descriptor.generationID === undefined) {
        throw new LatchwayLifecycleError("client_logged_out", "Activate the native app account before creating a client.");
      }
      const after = await this.snapshot();
      if (descriptor.generationID !== capturedGeneration || after.generationID !== capturedGeneration || after.state !== "active") {
        throw new LatchwayLifecycleError("account_changed");
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
    const initial = await this.snapshot();
    let afterRevision = initial.revision;
    yield initial;
    while (!signal?.aborted) {
      const next = await command(this.module, { operation: "observe", name: this.name, afterRevision });
      if (signal?.aborted) return;
      const accepted = this.accept(next);
      if (accepted.revision > afterRevision) {
        afterRevision = accepted.revision;
        yield accepted;
      }
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

/** An opaque login handle. Old handles can never refresh or log out a newer user. */
export class LatchwayAccount {
  /** @internal Obtain through signIn, restore or currentAccount. */
  constructor(private readonly app: LatchwayApp, private readonly generationID: string) {}
  async makeClient(): Promise<LatchwayClient> { return this.app.makeClient(this.generationID); }
  async updateIdToken(input: LatchwayTokenInput, bindingID?: string): Promise<void> {
    await this.app.identityOperation("update", input, this.generationID, bindingID);
  }
  async logout(): Promise<void> { await this.app.logout(this.generationID); }
}

/** Matching native configuration is a no-op; omitted settings inherit it. */
export async function configureLatchwayApp(options: LatchwayAppOptions, name = "[DEFAULT]"): Promise<LatchwayApp> {
  const module = await nativeModule();
  requireAppModule(module);
  const { getIdentitySnapshot, ...publicOptions } = options;
  const supplied = options.identity !== undefined && "providerID" in options.identity;
  if (supplied) {
    validateIdentityConfiguration(options.identity as LatchwayIdentityConfiguration);
    if (getIdentitySnapshot !== undefined || options.identityProvider !== undefined) {
      throw new LatchwayLifecycleError("configuration_conflict", "Supplied identity cannot install a legacy token authority.");
    }
  }
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
      ...(supplied ? { identityMode: "supplied" } : {}),
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
  const identity = options.identity;
  return JSON.stringify([new URL(options.baseURL).href.replace(/\/$/u, ""), options.applicationID,
    options.environment, identity !== undefined && "name" in identity ? identity.name : undefined,
    identity?.issuer, identity !== undefined && "name" in identity ? identity.tenant : undefined]);
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
  if (![1, 2].includes(record.nativeAppABI as number) || record.contractVersion !== "1.1.0" || record.protocolVersion !== 3 ||
      record.identityMode !== undefined && !["supplied", "authority"].includes(record.identityMode as string) ||
      !Number.isSafeInteger(record.revision) || (record.revision as number) < 0 ||
      !["inactive", "active", "refreshRequired", "retiring", "loggedOut"].includes(record.state as string) ||
      !["react_native_ios", "react_native_android"].includes(record.platform as string) ||
      ["baseURL", "applicationID", "environment", "nativeSDKVersion", "appInstanceID", "authorityInstanceID"]
        .some((key) => typeof record[key] !== "string" || !record[key].length || record[key].length > 2048) ||
      !UUID.test(record.appInstanceID as string) || !UUID.test(record.authorityInstanceID as string) ||
      record.generationID !== undefined && (typeof record.generationID !== "string" || !UUID.test(record.generationID)) ||
      ["active", "refreshRequired"].includes(record.state as string) && record.generationID === undefined) throw invalidResponse();
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
  "baseURL", "applicationID", "environment", "nativeSDKVersion", "appInstanceID", "authorityInstanceID", "generationID", "componentKeychainAccessGroups", "identityMode"]);

async function beginIdentity(module: NativeLatchwayModule, input: Record<string, unknown>): Promise<string> {
  return opaqueHandle(module, input, "ticketID");
}

async function opaqueHandle(module: NativeLatchwayModule, input: Record<string, unknown>, key: "ticketID" | "bindingID"): Promise<string> {
  const encoded = await module.appCommand(JSON.stringify(input)).catch((error: unknown) => { throw fromNativeError(error); });
  if (encoded.length > 128) throw invalidResponse();
  let value: unknown;
  try { value = JSON.parse(encoded); } catch { throw invalidResponse(); }
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !(key in value)) throw invalidResponse();
  const handle = (value as Record<string, unknown>)[key];
  if (typeof handle !== "string" || !UUID.test(handle)) throw invalidResponse();
  return handle;
}

function publicSnapshot(value: AppDescriptor): LatchwayAppSnapshot {
  return { appInstanceID: value.appInstanceID, authorityInstanceID: value.authorityInstanceID,
    revision: value.revision, state: value.state,
    ...(value.generationID === undefined ? {} : { generationID: value.generationID }) };
}

function invalidResponse(): LatchwayError {
  return new LatchwayError("protocol_response_invalid", "The native shared-app response is incompatible.");
}

import { LatchwayError } from "@latchway/client";
import type { LatchwayAccount, LatchwayApp } from "./app.js";

/** Public expectations; only the gateway can authenticate a signed ID token. */
export interface LatchwayIdentityConfiguration {
  providerID: string;
  issuer: string;
  audience: string;
  tenantID?: string;
}

/** Pure configuration helper. No Firebase SDK, discovery, listener or network. */
export function firebaseProject(options: {
  projectID: string; tenantID?: string; providerID?: string;
}): LatchwayIdentityConfiguration {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u.test(options.projectID)) throw invalidIdentity();
  return jwtIdentity({ providerID: options.providerID ?? "firebase",
    issuer: `https://securetoken.google.com/${options.projectID}`, audience: options.projectID,
    ...(options.tenantID === undefined ? {} : { tenantID: options.tenantID }) });
}

/** Validate/copy public metadata without contacting or importing an auth provider. */
export function jwtIdentity(options: LatchwayIdentityConfiguration): LatchwayIdentityConfiguration {
  validateIdentityConfiguration(options);
  return Object.freeze({ providerID: options.providerID, issuer: options.issuer, audience: options.audience,
    ...(options.tenantID === undefined ? {} : { tenantID: options.tenantID }) });
}

/** @internal Shared validation for generic object configuration. */
export function validateIdentityConfiguration(value: LatchwayIdentityConfiguration): void {
  if (typeof value.providerID !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.providerID) ||
      typeof value.audience !== "string" || value.audience.length === 0 || value.audience.length > 2048 ||
      /[\s\p{Cc}]/u.test(value.audience) || typeof value.issuer !== "string" || value.issuer.length > 2048 ||
      (value.tenantID !== undefined && (typeof value.tenantID !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(value.tenantID)))) throw invalidIdentity();
  let issuer: URL;
  try { issuer = new URL(value.issuer); } catch { throw invalidIdentity(); }
  if (issuer.protocol !== "https:" || issuer.username || issuer.password || issuer.search || issuer.hash) throw invalidIdentity();
}

/** Intent comes from application auth code, never from comparing user wrappers. */
export type LatchwayAuthEvent =
  | { type: "restore" | "signIn" | "tokenChanged"; getIdToken: () => Promise<string> }
  | { type: "signOut" };

export interface LatchwayAuthBinding {
  /** Releases this binding and cancels pending work; does not log out an account. */
  dispose(): Promise<void>;
  /** Resolves when events already received have settled. */
  settled(): Promise<void>;
}

/** Optional lifecycle glue for one application-owned auth source. The caller
 * supplies explicit intent, token acquisition and subscription cleanup. Other
 * native/RN surfaces attach to the account without installing another binding. */
export async function bindLatchwayAuth(app: LatchwayApp, options: {
  subscribe: (listener: (event: LatchwayAuthEvent) => void) => () => void;
  onError: (error: Error) => void;
}): Promise<LatchwayAuthBinding> {
  const bindingID = await app.claimIdentityBinding();
  let disposed = false;
  let pending: AbortController | undefined;
  let account: LatchwayAccount | null;
  try { account = await app.currentAccount(); }
  catch (error) { await app.releaseIdentityBinding(bindingID); throw error; }
  let queue: Promise<void> = Promise.resolve();
  let epoch = 0;
  let unsubscribe: (() => void) | undefined;
  const binding: LatchwayAuthBinding = {
    async settled() { await queue; },
    async dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      pending?.abort();
      unsubscribe?.();
      await queue;
      await app.releaseIdentityBinding(bindingID);
    },
  };
  try {
    unsubscribe = options.subscribe(event => {
      if (disposed) return;
      if (event.type !== "tokenChanged") {
        epoch += 1;
        pending?.abort();
      }
      const current = epoch;
      // Cancel immediately, not after an earlier application's token callback.
      const controller = new AbortController();
      queue = queue.then(async () => {
        if (disposed || current !== epoch) return;
        pending = controller;
        if (event.type === "signOut") {
          // Captured handles never turn a delayed A logout into a B logout.
          const captured = account;
          account = null;
          await captured?.logout();
          return;
        }
        const token = { getIdToken: event.getIdToken, signal: controller.signal };
        if (event.type === "signIn") account = await app.identityOperation("signIn", token, undefined, bindingID);
        else if (event.type === "restore") account = await app.identityOperation("restore", token, undefined, bindingID);
        else {
          const captured = account ?? await app.currentAccount();
          if (captured === null) return; // Refresh never implicitly signs in.
          await captured.updateIdToken(token, bindingID);
          account = captured;
        }
      }).catch((error: unknown) => {
        if (controller.signal.aborted || disposed) return;
        // Native/app methods redact errors. Never forward arbitrary auth values.
        try { options.onError(error instanceof Error ? error : new Error("Latchway auth synchronization failed.")); }
        catch { /* Application error handlers cannot break the binding queue. */ }
      });
    });
  } catch (error) {
    disposed = true;
    pending?.abort();
    await app.releaseIdentityBinding(bindingID);
    throw error;
  }
  return binding;
}

function invalidIdentity(): LatchwayError {
  return new LatchwayError("client_configuration_invalid", "Supply valid public identity provider, issuer, audience and tenant settings.");
}

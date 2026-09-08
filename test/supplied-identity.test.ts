import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLatchwayApp } from "../src/app.js";
import { bindLatchwayAuth, firebaseProject, jwtIdentity, type LatchwayAuthEvent } from "../src/identity.js";
import { installNativeModuleForTesting, type NativeLatchwayModule } from "../src/testing.js";

const APP = "0e5244a0-4c04-4bcf-a4da-6102a25ad8c1";
const OWNER = "65267a94-2a5f-4f76-84ca-e697a21b44e5";
const A = "58da9766-77db-42a0-a4dd-b0f71abae5db";
const B = "41fa3a6c-c52e-4a51-a42e-77dc1949aada";
const TICKET = "bedc5cb2-275d-46f8-9962-fa6d7b1c3e4b";
const BINDING = "cc5c9f64-a83b-4d74-949f-a9be0a4241e9";
const options = { baseURL: "https://gateway.example.test", applicationID: "habitify", environment: "development",
  identity: firebaseProject({ projectID: "habitify-dev" }) };
let restore: (() => void) | undefined;
afterEach(() => restore?.());

function fixture() {
  const state = { nativeAppABI: 2, identityMode: "supplied", contractVersion: "1.1.0", protocolVersion: 3,
    nativeSDKVersion: "1.2.0", baseURL: options.baseURL, applicationID: options.applicationID, environment: options.environment,
    platform: "react_native_ios", appInstanceID: APP, authorityInstanceID: OWNER,
    state: "inactive", revision: 0, generationID: undefined as string | undefined };
  const calls: Array<Record<string, unknown>> = [];
  let cancelled = false;
  let binding = false;
  const appCommand = vi.fn(async (encoded: string) => {
    const request = JSON.parse(encoded) as Record<string, unknown>;
    calls.push(request);
    if (request.operation === "beginIdentity") {
      if (request.generationID !== undefined && request.generationID !== state.generationID) throw Object.assign(new Error(), { code: "account_changed" });
      cancelled = false;
      return JSON.stringify({ ticketID: TICKET });
    }
    if (request.operation === "cancelIdentity") cancelled = true;
    if (request.operation === "claimIdentityBinding") {
      if (binding) throw Object.assign(new Error(), { code: "configuration_conflict" });
      binding = true;
      return JSON.stringify({ bindingID: BINDING });
    }
    if (request.operation === "releaseIdentityBinding") binding = false;
    if (request.operation === "completeIdentity") {
      if (cancelled) throw Object.assign(new Error(), { code: "account_changed" });
      Object.assign(state, { state: "active", generationID: state.generationID ?? A, revision: state.revision + 1 });
    }
    if (request.operation === "logout") {
      if (request.generationID !== state.generationID) throw Object.assign(new Error(), { code: "account_changed" });
      Object.assign(state, { state: "loggedOut", revision: state.revision + 1 });
    }
    return JSON.stringify(state);
  });
  const dispose = vi.fn(async () => undefined);
  const module = { appCommand, dispose } as unknown as NativeLatchwayModule;
  restore = installNativeModuleForTesting(module);
  return { state, calls, appCommand, module, dispose };
}

describe("developer-supplied identity (mock bridge)", () => {
  it("formats metadata without installing a provider or fetching a token", async () => {
    const f = fixture();
    await configureLatchwayApp(options);
    expect(f.calls).toEqual([{ ...options, identityMode: "supplied", operation: "configure", name: "[DEFAULT]" }]);
    expect(options.identity).toEqual({ providerID: "firebase", issuer: "https://securetoken.google.com/habitify-dev", audience: "habitify-dev" });
    expect(() => firebaseProject({ projectID: "../other" })).toThrow();
    expect(() => jwtIdentity({ providerID: "oidc", issuer: "https://user:secret@issuer.test", audience: "app" })).toThrow();
    expect(() => jwtIdentity({ providerID: "oidc", issuer: "http://issuer.test", audience: "app" })).toThrow();
  });

  it("rejects a supplied config mixed with legacy callback ownership", async () => {
    const f = fixture();
    await expect(configureLatchwayApp({ ...options, getIdentitySnapshot: async () => null })).rejects.toMatchObject({ code: "configuration_conflict" });
    expect(f.calls).toHaveLength(0);
  });

  it("captures the native ticket before token acquisition and returns an account", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const account = await app.signIn({ getIdToken: async () => {
      expect(f.calls.at(-1)?.operation).toBe("beginIdentity");
      return "token-a";
    } });
    await account.updateIdToken({ idToken: "fresh-token-a" });
    expect(f.calls.filter(c => c.operation === "beginIdentity").at(-1)).toMatchObject({ intent: "update", generationID: A });
    const client = await account.makeClient();
    expect(f.calls.find(c => c.operation === "client")).toMatchObject({ generationID: A });
    await client.dispose();
    await account.logout();
    expect(f.calls.at(-1)).toMatchObject({ operation: "logout", generationID: A });
    expect(await app.currentAccount()).toBeNull();
  });

  it("keeps old account handles bound to A when B becomes current", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const old = await app.signIn({ idToken: "token-a" });
    Object.assign(f.state, { generationID: B, revision: 3 });
    await expect(old.makeClient()).rejects.toMatchObject({ code: "account_changed" });
    await expect(old.updateIdToken({ idToken: "token-b" })).rejects.toMatchObject({ code: "account_changed" });
    await expect(old.logout()).rejects.toMatchObject({ code: "account_changed" });
    expect(f.state.generationID).toBe(B);
    expect(f.state.state).toBe("active");
  });

  it("joins a suspended account to update identity but prevents ordinary client work", async () => {
    const f = fixture();
    Object.assign(f.state, { state: "refreshRequired", generationID: A });
    const app = await configureLatchwayApp(options);
    const account = await app.currentAccount();
    expect(account).not.toBeNull();
    await expect(account?.makeClient()).rejects.toMatchObject({ code: "identity_refresh_required" });
    await account?.updateIdToken({ idToken: "fresh-token-a" });
    expect(f.state.state).toBe("active");
  });

  it("cancels native pending sign-in before any account exists and fences a late callback", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const controller = new AbortController();
    let supply: ((value: string) => void) | undefined;
    const signingIn = app.signIn({ signal: controller.signal, getIdToken: () => new Promise(resolve => { supply = resolve; }) });
    const rejected = expect(signingIn).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(supply).toBeDefined());
    controller.abort();
    await rejected;
    expect(f.calls.at(-1)).toMatchObject({ operation: "cancelIdentity", ticketID: TICKET });
    supply?.("late-token");
    await Promise.resolve();
    expect(f.calls.some(c => c.operation === "completeIdentity")).toBe(false);
  });

  it("cancels when aborted while native is reserving the ticket", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const controller = new AbortController();
    let completeBegin: ((value: string) => void) | undefined;
    f.appCommand.mockImplementationOnce(() => new Promise(resolve => { completeBegin = resolve; }));
    const token = vi.fn(async () => "token-a");
    const signingIn = app.signIn({ signal: controller.signal, getIdToken: token });
    controller.abort();
    completeBegin?.(JSON.stringify({ ticketID: TICKET }));
    await expect(signingIn).rejects.toMatchObject({ name: "AbortError" });
    expect(token).not.toHaveBeenCalled();
    expect(f.calls.at(-1)?.operation).toBe("cancelIdentity");
  });

  it("redacts application token producer failures and cancels its ticket", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    await expect(app.signIn({ getIdToken: async () => { throw new Error("secret-token-value"); } }))
      .rejects.toMatchObject({ code: "identity_unavailable", message: "The application could not supply an ID token." });
    expect(f.calls.at(-1)?.operation).toBe("cancelIdentity");
  });

  it("requires the new native ABI for supplied operations", async () => {
    const f = fixture();
    f.state.nativeAppABI = 1;
    const app = await configureLatchwayApp(options);
    await expect(app.signIn({ idToken: "token-a" })).rejects.toMatchObject({ code: "native_version_incompatible" });
  });

  it("observers keep independent cursors even when another command sees a revision", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const first = app.states();
    const second = app.states();
    await first.next();
    await second.next();
    await app.signIn({ idToken: "token-a" });
    expect((await first.next()).value).toMatchObject({ state: "active" });
    expect((await second.next()).value).toMatchObject({ state: "active" });
    expect(f.calls.filter(c => c.operation === "observe").map(c => c.afterRevision)).toEqual([0, 0]);
    await first.return(undefined);
    await second.return(undefined);
  });

  it("binds one explicit auth source and dispose does not sign out", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    let send: ((event: LatchwayAuthEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const onError = vi.fn();
    const binding = await bindLatchwayAuth(app, { subscribe: listener => { send = listener; return unsubscribe; }, onError });
    const other = await configureLatchwayApp(options);
    await expect(bindLatchwayAuth(other, { subscribe: () => () => undefined, onError })).rejects.toMatchObject({ code: "configuration_conflict" });
    send?.({ type: "restore", getIdToken: async () => "token-a" });
    send?.({ type: "tokenChanged", getIdToken: async () => "fresh-token-a" });
    await binding.settled();
    expect(f.calls.filter(c => c.operation === "beginIdentity").map(c => c.intent)).toEqual(["restore", "update"]);
    expect(onError).not.toHaveBeenCalled();
    await binding.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(f.state.state).toBe("active");
    expect(f.calls.at(-1)?.operation).toBe("releaseIdentityBinding");
  });
});

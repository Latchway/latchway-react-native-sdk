import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLatchwayApp } from "../src/app.js";
import { bindLatchwayAuth, firebaseProject, type LatchwayAuthEvent } from "../src/identity.js";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(platform = "react_native_ios") {
  const state = { nativeAppABI: 2, identityMode: "supplied", contractVersion: "1.1.0", protocolVersion: 3,
    nativeSDKVersion: platform === "react_native_ios" ? "1.3.0" : "1.2.0",
    baseURL: options.baseURL, applicationID: options.applicationID, environment: options.environment,
    platform, appInstanceID: APP, authorityInstanceID: OWNER,
    state: "inactive", revision: 0, generationID: undefined as string | undefined };
  const calls: Array<Record<string, unknown>> = [];
  let cancelled = false;
  let nextGeneration = A;
  let cleanup: (() => Promise<void>) | undefined;
  let begin: (() => Promise<void>) | undefined;
  let cancel: (() => Promise<void>) | undefined;
  const appCommand = vi.fn(async (encoded: string) => {
    const request = JSON.parse(encoded) as Record<string, unknown>;
    calls.push(request);
    if (request.operation === "beginIdentity") {
      await begin?.();
      if (state.state === "retiring") throw Object.assign(new Error(), { code: "cleanup_required" });
      cancelled = false;
      return JSON.stringify({ ticketID: TICKET });
    }
    if (request.operation === "cancelIdentity") { cancelled = true; await cancel?.(); }
    if (request.operation === "claimIdentityBinding") return JSON.stringify({ bindingID: BINDING });
    if (request.operation === "completeIdentity") {
      if (cancelled) throw Object.assign(new Error(), { code: "account_changed" });
      Object.assign(state, { state: "active", generationID: nextGeneration, revision: state.revision + 1 });
    }
    if (request.operation === "signOut") {
      cancelled = true;
      Object.assign(state, { state: "retiring", revision: state.revision + 1 });
      await cleanup?.();
      Object.assign(state, { state: "loggedOut", generationID: undefined, revision: state.revision + 1 });
    }
    if (request.operation === "logout" && request.generationID === state.generationID) {
      Object.assign(state, { state: "loggedOut", generationID: undefined, revision: state.revision + 1 });
    }
    return JSON.stringify(state);
  });
  const module = { appCommand, dispose: vi.fn(async () => undefined) } as unknown as NativeLatchwayModule;
  restore = installNativeModuleForTesting(module);
  return { state, calls, appCommand, setGeneration: (value: string) => { nextGeneration = value; },
    setCleanup: (value?: () => Promise<void>) => { cleanup = value; },
    setCancel: (value?: () => Promise<void>) => { cancel = value; },
    setBegin: (value?: () => Promise<void>) => { begin = value; } };
}

describe("app-level signOut (mock bridge)", () => {
  it.each(["react_native_ios", "react_native_android"])("delegates current-account cleanup to %s without a snapshot", async platform => {
    const f = fixture(platform);
    const app = await configureLatchwayApp(options);
    await app.signIn({ idToken: "token-a" });
    f.calls.length = 0;
    await app.signOut();
    expect(f.calls).toEqual([{ operation: "signOut", name: "[DEFAULT]" }]);
    expect(await app.currentAccount()).toBeNull();
  });

  it.each(["inactive", "loggedOut", "retiring", "refreshRequired"])("uses native recovery for %s", async state => {
    const f = fixture();
    Object.assign(f.state, { state, generationID: state === "refreshRequired" ? A : undefined });
    const app = await configureLatchwayApp(options);
    await app.signOut();
    expect(f.state.state).toBe("loggedOut");
    expect(f.calls.some(call => call.operation === "snapshot" || call.operation === "logout")).toBe(false);
  });

  it("coalesces concurrent signOut calls through separate wrappers", async () => {
    const f = fixture();
    const gate = deferred<undefined>();
    f.setCleanup(() => gate.promise);
    const app = await configureLatchwayApp(options);
    const other = await configureLatchwayApp(options);
    const first = app.signOut();
    const second = other.signOut();
    expect(f.calls.filter(call => call.operation === "signOut")).toHaveLength(1);
    await expect(other.signIn({ idToken: "too-early" })).rejects.toMatchObject({ code: "cleanup_required" });
    gate.resolve(undefined);
    await Promise.all([first, second]);
    expect(f.state.state).toBe("loggedOut");
  });

  it("propagates cleanup failure and retries using the same simple API", async () => {
    const f = fixture();
    f.setCleanup(async () => { throw Object.assign(new Error(), { code: "cleanup_required" }); });
    const app = await configureLatchwayApp(options);
    await expect(app.signOut()).rejects.toMatchObject({ code: "cleanup_required" });
    expect(f.state.state).toBe("retiring");
    f.setCleanup();
    await app.signOut();
    expect(f.state.state).toBe("loggedOut");
    await app.signIn({ idToken: "token-b" });
    expect(f.state.state).toBe("active");
  });

  it("cancels a pending producer in another wrapper without waiting for its token", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const other = await configureLatchwayApp(options);
    const gate = deferred<string>();
    const producer = vi.fn(() => gate.promise);
    const signingIn = app.signIn({ getIdToken: producer });
    const rejected = expect(signingIn).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(producer).toHaveBeenCalledOnce());
    await other.signOut();
    await rejected;
    f.setGeneration(B);
    const account = await other.signIn({ idToken: "token-b" });
    gate.resolve("late-token-a");
    await Promise.resolve();
    expect(f.calls.filter(call => call.operation === "completeIdentity").map(call => call.idToken)).toEqual(["token-b"]);
    expect(f.state.generationID).toBe(B);
    await account.makeClient();
  });

  it("settles a delayed native ticket before signOut reports success", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const gate = deferred<undefined>();
    f.setBegin(() => gate.promise);
    const producer = vi.fn(async () => "late-token");
    const signingIn = app.signIn({ getIdToken: producer });
    const rejected = expect(signingIn).rejects.toMatchObject({ name: "AbortError" });
    const signedOut = vi.fn();
    const signingOut = app.signOut().then(signedOut);
    await Promise.resolve();
    expect(signedOut).not.toHaveBeenCalled();
    gate.resolve(undefined);
    await signingOut;
    await rejected;
    expect(producer).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.operation === "cancelIdentity")).toBe(true);
  });

  it("reports failed cancellation of a delayed ticket and permits cleanup retry", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const gate = deferred<undefined>();
    f.setBegin(() => gate.promise);
    f.setCancel(async () => {
      Object.assign(f.state, { state: "retiring", revision: f.state.revision + 1 });
      throw Object.assign(new Error(), { code: "cleanup_required" });
    });
    const signingIn = app.signIn({ idToken: "token-a" });
    const rejected = expect(signingIn).rejects.toMatchObject({ code: "cleanup_required" });
    const signingOut = app.signOut();
    const cleanupRejected = expect(signingOut).rejects.toMatchObject({ code: "cleanup_required" });
    await Promise.resolve();
    gate.resolve(undefined);
    await Promise.all([rejected, cleanupRejected]);
    expect(f.state.state).toBe("retiring");
    f.setCancel();
    f.setBegin();
    await app.signOut();
    f.setGeneration(B);
    await app.signIn({ idToken: "token-b" });
    expect(f.state.generationID).toBe(B);
    expect(f.state.state).toBe("active");
  });

  it("allows a new generation and preserves generation-scoped old-account logout", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    const oldAccount = await app.signIn({ idToken: "token-a" });
    await app.signOut();
    f.setGeneration(B);
    await app.signIn({ idToken: "token-b" });
    await oldAccount.logout();
    expect(f.state.generationID).toBe(B);
    expect(f.state.state).toBe("active");
  });

  it("does not cancel pending work for a different native app", async () => {
    const f = fixture();
    const first = await configureLatchwayApp(options);
    f.state.appInstanceID = B;
    const second = await configureLatchwayApp(options, "other");
    const producer = deferred<string>();
    const token = vi.fn(() => producer.promise);
    const signingIn = first.signIn({ getIdToken: token });
    // The fixture shares descriptors, so check only that signOut does not send
    // a cancellation for the first app; abort it explicitly at the end.
    const failure = signingIn.catch(() => undefined);
    await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
    await second.signOut();
    expect(f.calls.some(call => call.operation === "cancelIdentity")).toBe(false);
    producer.resolve("token-a");
    await failure;
  });

  it.each([["react_native_ios", "1.2.0"], ["react_native_android", "1.1.0"]])(
    "requires a native rebuild for %s %s", async (platform, version) => {
      const f = fixture(platform);
      f.state.nativeSDKVersion = version;
      const app = await configureLatchwayApp(options);
      await expect(app.signOut()).rejects.toMatchObject({ code: "native_version_incompatible" });
      expect(f.calls.some(call => call.operation === "signOut")).toBe(false);
    });

  it("auth binding signOut retires an unpublished account without currentAccount", async () => {
    const f = fixture();
    const app = await configureLatchwayApp(options);
    let send: ((event: LatchwayAuthEvent) => void) | undefined;
    const onError = vi.fn();
    const binding = await bindLatchwayAuth(app, { subscribe: listener => { send = listener; return () => undefined; }, onError });
    f.calls.length = 0;
    send?.({ type: "signOut" });
    await binding.settled();
    expect(onError).not.toHaveBeenCalled();
    expect(f.calls).toEqual([{ operation: "signOut", name: "[DEFAULT]" }]);
    await binding.dispose();
  });
});

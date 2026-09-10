import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLatchwayApp, getLatchwayApp } from "../src/app.js";
import { installNativeModuleForTesting, type NativeLatchwayModule } from "../src/testing.js";

const APP = "0e5244a0-4c04-4bcf-a4da-6102a25ad8c1";
const GENERATION = "58da9766-77db-42a0-a4dd-b0f71abae5db";
const options = { baseURL: "https://gateway.example.test/prefix", applicationID: "habitify", environment: "production" };
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); });

function fixture() {
  const state: Record<string, unknown> = {
    nativeAppABI: 3, identityMode: "supplied", contractVersion: "1.1.0", protocolVersion: 3, nativeSDKVersion: "1.1.0",
    ...options, platform: "react_native_ios", appInstanceID: APP,
    state: "inactive", revision: 0,
  };
  const requests: Array<Record<string, unknown>> = [];
  const dispose = vi.fn(async () => undefined);
  const appCommand = vi.fn(async (json: string) => {
    const request = JSON.parse(json) as Record<string, unknown>;
    requests.push(request);
    if (request.operation === "beginIdentity") return JSON.stringify({ ticketID: "bedc5cb2-275d-46f8-9962-fa6d7b1c3e4b" });
    if (request.operation === "completeIdentity") Object.assign(state, { state: "active", generationID: GENERATION, revision: 1 });
    if (request.operation === "logout") Object.assign(state, { state: "loggedOut", revision: 2 });
    return JSON.stringify(state);
  });
  const module = { appCommand, dispose } as unknown as NativeLatchwayModule;
  restore = installNativeModuleForTesting(module);
  return { state, requests, module, appCommand, dispose };
}

describe("shared native app wrapper contract (mock bridge)", () => {
  it("configure preserves omission and does not activate or supply a JS auth default", async () => {
    const f = fixture();
    const first = await configureLatchwayApp(options);
    const second = await configureLatchwayApp(options);
    expect(first.instanceID).toBe(second.instanceID);
    expect(first.gatewayURL).toBe(options.baseURL);
    expect(f.requests).toEqual([
      { ...options, identityMode: "supplied", operation: "configure", name: "[DEFAULT]" },
      { ...options, identityMode: "supplied", operation: "configure", name: "[DEFAULT]" },
    ]);
  });

  it.each([
    { apple: { appAttestEnvironment: "any" } },
    { apple: { environment: "development" } },
    { allowTestingResponses: true },
    { isTestingResponse: true },
    { minimumTrustLevel: "debug" },
  ])("does not let JS configuration assert attestation environment or trust: %j", async (unsupported) => {
    const f = fixture();
    const invalid = { ...options, ...unsupported } as unknown as Parameters<typeof configureLatchwayApp>[0];
    await expect(configureLatchwayApp(invalid)).rejects.toMatchObject({
      code: "configuration_conflict",
    });
    expect(f.requests).toHaveLength(0);
  });

  it("logout forwards the captured generation and preserves the registered app", async () => {
    const f = fixture();
    const app = await getLatchwayApp("production");
    await app.signIn({ idToken: "token-a" });
    const active = await app.snapshot();
    expect(active.generationID).toBe(GENERATION);
    await app.logout(GENERATION);
    expect(f.requests.at(-1)).toEqual({ operation: "logout", name: "production", generationID: GENERATION });
    expect(await app.snapshot()).toEqual({ appInstanceID: APP,
      generationID: GENERATION, revision: 2, state: "loggedOut" });
  });

  it("does not allow an older snapshot to overwrite newer lifecycle state", async () => {
    const f = fixture();
    const app = await getLatchwayApp();
    await app.signIn({ idToken: "token-a" });
    await app.logout(GENERATION);
    Object.assign(f.state, { state: "active", revision: 1 });
    expect((await app.snapshot()).state).toBe("loggedOut");
  });

  it("an observation finishing after logout cannot emit its stale active snapshot", async () => {
    const f = fixture();
    const app = await getLatchwayApp();
    await app.signIn({ idToken: "token-a" });
    const stop = new AbortController();
    const observations = app.states(stop.signal);
    const first = await observations.next();
    if (first.done) throw new Error("Expected initial snapshot");
    expect(first.value.state).toBe("active");
    let release: ((value: string) => void) | undefined;
    const stale = JSON.stringify(f.state);
    f.appCommand.mockImplementationOnce(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = observations.next();
    await vi.waitFor(() => expect(release).toBeDefined());
    await app.logout(GENERATION);
    if (!release) throw new Error("Expected pending observation");
    release(stale);
    const next = await pending;
    if (next.done) throw new Error("Expected logout snapshot");
    expect(next.value.state).toBe("loggedOut");
    stop.abort();
    await observations.return(undefined);
  });

  it("a second runtime joins a native owner without stealing auth or activating a logged-out app", async () => {
    const f = fixture();
    const first = await getLatchwayApp();
    await first.signIn({ idToken: "token-a" });
    await first.logout(GENERATION);
    restore?.();
    // A distinct bridge object represents a different JS runtime. The backend
    // descriptor is native-owned and is intentionally shared by both adapters.
    const secondBridge = {...f.module, appCommand: f.appCommand} as NativeLatchwayModule;
    restore = installNativeModuleForTesting(secondBridge);
    const second = await configureLatchwayApp(options);
    expect(second.instanceID).toBe(first.instanceID);
    expect((await second.snapshot()).state).toBe("loggedOut");
    expect(f.requests.filter(x => x.operation === "identityPoll")).toHaveLength(0);
    expect(f.requests.filter(x => x.operation === "completeIdentity")).toHaveLength(1);
  });

  it.each([
    { rawUserID: "private-user" }, { token: "private-token" }, { baseURL: "https://user:password@example.test" },
    { baseURL: "https://gateway.example.test/prefix?secret=value" }, { revision: -1 },
    { state: "active" }, { generationID: null }, { appInstanceID: "not-an-opaque-uuid" }, { nativeAppABI: 2 },
    { componentKeychainAccessGroups: ["TEAM.group", "TEAM.group"] }, { componentKeychainAccessGroups: ["*"] },
  ])("rejects incompatible or oversharing native snapshots: %j", async (changes) => {
    const f = fixture();
    Object.assign(f.state, changes);
    await expect(getLatchwayApp()).rejects.toBeInstanceOf(Error);
  });

  it("inherits native component group metadata without putting it into account state events", async () => {
    const f = fixture();
    f.state.componentKeychainAccessGroups = ["TEAM.example.extension"];
    const app = await getLatchwayApp();
    expect(await app.snapshot()).not.toHaveProperty("componentKeychainAccessGroups");
    await app.signIn({ idToken: "token-a" });
    const client = await app.makeClient();
    // Empty JS defaults must not reject the native-approved group before
    // its descriptor reaches native enforcement. Return a safe test response.
    const rootComponentDiagnostics = vi.fn(async () => JSON.stringify({}));
    f.module.rootComponentDiagnostics = rootComponentDiagnostics;
    await expect(client.componentDiagnostics({definitionID: "widget", kind: "widget",
      keychainAccessGroup: "TEAM.example.extension", requestedFeatures: ["chat"]})).rejects.toBeInstanceOf(Error);
    expect(rootComponentDiagnostics).toHaveBeenCalledOnce();
    await client.dispose();
  });

  it("accepts the native maximum of 256 concrete groups even above the old descriptor byte limit", async () => {
    const f = fixture();
    f.state.componentKeychainAccessGroups = Array.from({length: 256}, (_, index) =>
      `TEAM.${"x".repeat(240)}.${String(index).padStart(3, "0")}`);
    expect(JSON.stringify(f.state).length).toBeGreaterThan(16_384);
    const app = await getLatchwayApp();
    expect((await app.snapshot()).appInstanceID).toBe(APP);
    await app.signIn({ idToken: "token-a" });
    const client = await app.makeClient();
    await client.dispose();
  });

  it("rejects component group metadata beyond the native 256-group bound", async () => {
    const f = fixture();
    f.state.componentKeychainAccessGroups = Array.from({length: 257}, (_, index) => `TEAM.group${index}`);
    await expect(getLatchwayApp()).rejects.toBeInstanceOf(Error);
  });

  it("releases a native lease even when its response cannot be parsed safely", async () => {
    const f = fixture();
    const app = await getLatchwayApp();
    await app.signIn({ idToken: "token-a" });
    f.state.unexpectedCredential = "must-not-escape";
    await expect(app.makeClient()).rejects.toBeInstanceOf(Error);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });

  it("returns an actionable error for older native modules", async () => {
    fixture();
    restore?.();
    restore = installNativeModuleForTesting({} as NativeLatchwayModule);
    await expect(configureLatchwayApp(options)).rejects.toMatchObject({ code: "native_version_incompatible" });
  });
});

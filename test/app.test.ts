import { afterEach, describe, expect, it, vi } from "vitest";
import { configureLatchwayApp, getLatchwayApp } from "../src/app.js";
import { installNativeModuleForTesting, type NativeLatchwayModule } from "../src/testing.js";

const APP = "0e5244a0-4c04-4bcf-a4da-6102a25ad8c1";
const OWNER = "65267a94-2a5f-4f76-84ca-e697a21b44e5";
const GENERATION = "58da9766-77db-42a0-a4dd-b0f71abae5db";
const REPLACEMENT = "41fa3a6c-c52e-4a51-a42e-77dc1949aada";
const options = { baseURL: "https://gateway.example.test/prefix", applicationID: "habitify", environment: "production" };
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); });

function fixture() {
  const state: Record<string, unknown> = {
    nativeAppABI: 1, contractVersion: "1.1.0", protocolVersion: 3, nativeSDKVersion: "1.1.0",
    ...options, platform: "react_native_ios", appInstanceID: APP, authorityInstanceID: OWNER,
    state: "inactive", revision: 0,
  };
  const requests: Array<Record<string, unknown>> = [];
  const dispose = vi.fn(async () => undefined);
  const appCommand = vi.fn(async (json: string) => {
    const request = JSON.parse(json) as Record<string, unknown>;
    requests.push(request);
    if (request.operation === "newIdentityAuthority") return JSON.stringify({ authorityInstanceID: OWNER });
    if (request.operation === "identityPoll") return new Promise<string>(() => { /* stopped JS test owner */ });
    if (request.operation === "activate") Object.assign(state, { state: "active", generationID: GENERATION, revision: 1 });
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
      { ...options, operation: "configure", name: "[DEFAULT]" },
      { ...options, operation: "configure", name: "[DEFAULT]" },
    ]);
  });

  it("concurrent JS-owned configuration creates one native owner without replacing its callback", async () => {
    const f = fixture();
    const first = vi.fn(async () => null);
    const second = vi.fn(async () => null);
    const identity = { name: "firebase", issuer: "https://securetoken.google.com/habitify" };
    await Promise.all([
      configureLatchwayApp({ ...options, identity, getIdentitySnapshot: first }),
      configureLatchwayApp({ ...options, identity, getIdentitySnapshot: second }),
    ]);
    expect(f.requests.filter((x) => x.operation === "newIdentityAuthority")).toHaveLength(1);
    expect(f.requests.filter((x) => x.operation === "identityPoll")).toHaveLength(1);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(JSON.stringify(f.requests)).not.toContain("getIdentitySnapshot");
  });

  it("logout forwards the captured generation and preserves the registered app", async () => {
    const f = fixture();
    const app = await getLatchwayApp("production");
    const active = await app.activate();
    expect(active.generationID).toBe(GENERATION);
    await app.logout(GENERATION);
    expect(f.requests.at(-1)).toEqual({ operation: "logout", name: "production", generationID: GENERATION });
    expect(await app.snapshot()).toEqual({ appInstanceID: APP, authorityInstanceID: OWNER,
      generationID: GENERATION, revision: 2, state: "loggedOut" });
  });

  it("explicit reload transfer uses a captured owner, stays logged out, and retains the new callback", async () => {
    const f = fixture();
    const identity = { name: "firebase", issuer: "https://issuer.test" };
    const app = await getLatchwayApp();
    const current = await app.snapshot();
    f.appCommand.mockImplementation(async (json) => {
      const request = JSON.parse(json) as Record<string, unknown>;
      f.requests.push(request);
      if (request.operation === "newIdentityAuthority") return JSON.stringify({ authorityInstanceID: REPLACEMENT });
      if (request.operation === "identityPoll") return new Promise<string>(() => {});
      if (request.operation === "transferIdentityAuthority") {
        expect(request.expectedAuthorityInstanceID).toBe(OWNER);
        Object.assign(f.state, { authorityInstanceID: REPLACEMENT, state: "loggedOut", revision: 3 });
      }
      return JSON.stringify(f.state);
    });
    const callback = vi.fn(async () => null);
    const transferred = await app.transferIdentityAuthority({ identity, getIdentitySnapshot: callback,
      expectedAuthorityInstanceID: current.authorityInstanceID });
    expect(transferred.state).toBe("loggedOut");
    expect(transferred.authorityInstanceID).toBe(REPLACEMENT);
    expect(callback).not.toHaveBeenCalled();
    await configureLatchwayApp({ ...options, identity, getIdentitySnapshot: vi.fn(async () => null) });
    expect(f.requests.filter((x) => x.operation === "newIdentityAuthority")).toHaveLength(1);
    expect(f.requests.filter((x) => x.operation === "activate")).toHaveLength(0);
    expect(f.requests.at(-1)?.authorityInstanceID).toBe(REPLACEMENT);
  });

  it("does not allow an older snapshot to overwrite newer lifecycle state", async () => {
    const f = fixture();
    const app = await getLatchwayApp();
    await app.activate();
    await app.logout(GENERATION);
    Object.assign(f.state, { state: "active", revision: 1 });
    expect((await app.snapshot()).state).toBe("loggedOut");
  });

  it("an observation finishing after logout cannot emit its stale active snapshot", async () => {
    const f = fixture();
    const app = await getLatchwayApp();
    await app.activate();
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
    await first.activate();
    await first.logout(GENERATION);
    restore?.();
    // A distinct bridge object represents a different JS runtime. The backend
    // descriptor is native-owned and is intentionally shared by both adapters.
    const secondBridge = {...f.module, appCommand: f.appCommand} as NativeLatchwayModule;
    restore = installNativeModuleForTesting(secondBridge);
    const callback = vi.fn(async () => null);
    const original = f.appCommand.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    f.appCommand.mockImplementation(async json => {
      const request = JSON.parse(json) as Record<string, unknown>;
      if (request.operation === "newIdentityAuthority") return JSON.stringify({authorityInstanceID: REPLACEMENT});
      return original(json);
    });
    const second = await configureLatchwayApp({...options,
      identity: {name: "native-firebase", issuer: "https://issuer.test"}, getIdentitySnapshot: callback});
    expect(second.instanceID).toBe(first.instanceID);
    expect((await second.snapshot()).state).toBe("loggedOut");
    expect(callback).not.toHaveBeenCalled();
    expect(f.requests.filter(x => x.operation === "identityPoll")).toHaveLength(0);
    expect(f.requests.filter(x => x.operation === "activate")).toHaveLength(1);
  });

  it("failed first initialization allows a different callback on a safe retry", async () => {
    const f = fixture();
    const original = f.appCommand.getMockImplementation();
    if (!original) throw new Error("Missing fixture implementation");
    let configure = 0;
    f.appCommand.mockImplementation(async json => {
      const request = JSON.parse(json) as Record<string, unknown>;
      if (request.operation === "configure" && ++configure === 1) throw new Error("Configuration unavailable");
      return original(json);
    });
    const identity = {name: "standalone", issuer: "https://issuer.test"};
    await expect(configureLatchwayApp({...options, identity, getIdentitySnapshot: async () => null})).rejects.toBeInstanceOf(Error);
    await configureLatchwayApp({...options, identity, getIdentitySnapshot: async () => null});
    expect(f.requests.filter(x => x.operation === "newIdentityAuthority")).toHaveLength(2);
  });

  it.each([
    { rawUserID: "private-user" }, { token: "private-token" }, { baseURL: "https://user:password@example.test" },
    { baseURL: "https://gateway.example.test/prefix?secret=value" }, { revision: -1 },
    { state: "active" }, { generationID: null }, { appInstanceID: "not-an-opaque-uuid" }, { nativeAppABI: 3 },
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
    await app.activate();
    const client = await app.makeClient();
    // Legacy empty JS defaults must not reject the native-approved group before
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
    await app.activate();
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
    await app.activate();
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

import { LatchwayError } from "@latchway/client";
import type { RuntimeComponentConfiguration } from "./config.js";
import { fromNativeError, nativeUnavailable } from "./errors.js";
import { assertNoCredentialFields } from "./native-output.js";
import { nativeModule, type NativeLatchwayModule } from "./native/bridge.js";
import type { ReactNativePlatform } from "./types.js";
import { SDK_VERSION } from "./version.js";

interface Compatibility {
  platform: ReactNativePlatform;
  nativeSDKVersion: string;
  contractVersion: string;
  protocolVersion: number;
}

interface Entry {
  clientID: string;
  fingerprint: string;
  module: NativeLatchwayModule;
  ready: Promise<Compatibility>;
  references: number;
}

export interface NativeLease {
  clientID: string;
  module: NativeLatchwayModule;
  ready: Promise<Compatibility>;
  release(): Promise<void>;
}

const componentEntries = new Map<string, Entry>();
const moduleIDs = new WeakMap<object, number>();
let nextModuleID = 1;
let nextClientID = 1;

export async function acquireComponent(config: RuntimeComponentConfiguration): Promise<NativeLease> {
  let module: NativeLatchwayModule;
  try {
    module = await nativeModule();
  } catch (cause) {
    throw nativeUnavailable(cause);
  }
  const moduleID = identityFor(module);
  const key = `${moduleID}|component|${config.scope}`;
  const existing = componentEntries.get(key);
  if (existing !== undefined) {
    if (existing.fingerprint !== config.fingerprint) {
      throw new LatchwayError(
        "client_configuration_invalid",
        "Conflicting Latchway component configuration is active for this extension scope.",
      );
    }
    existing.references += 1;
    return lease(componentEntries, key, existing);
  }

  const clientID = `latchway-rn-component-${nextClientID++}`;
  const entry: Entry = {
    clientID,
    fingerprint: config.fingerprint,
    module,
    references: 1,
    ready: emptyCompatibility(),
  };
  entry.ready = module.configureComponent(clientID, config.nativeJSON, config.componentJSON)
    .then(parseCompatibility)
    .catch(async (cause: unknown) => {
      if (componentEntries.get(key) === entry) componentEntries.delete(key);
      try { await module.dispose(clientID); } catch { /* preserve the original failure */ }
      throw fromNativeError(cause);
    });
  componentEntries.set(key, entry);
  return lease(componentEntries, key, entry);
}

function lease(owner: Map<string, Entry>, key: string, entry: Entry): NativeLease {
  let released = false;
  return {
    clientID: entry.clientID,
    module: entry.module,
    ready: entry.ready,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references !== 0 || owner.get(key) !== entry) return;
      owner.delete(key);
      try {
        await entry.ready;
        await entry.module.dispose(entry.clientID);
      } catch (cause) {
        throw fromNativeError(cause);
      }
    },
  };
}

function emptyCompatibility(): Promise<Compatibility> {
  return Promise.resolve({
    platform: "react_native_ios",
    nativeSDKVersion: "",
    contractVersion: "",
    protocolVersion: 0,
  });
}

function parseCompatibility(encoded: string): Compatibility {
  const value = parseRecord(encoded, "native compatibility");
  assertNoCredentialFields(value);
  if (!hasOnlyKeys(value, ["platform", "nativeSDKVersion", "contractVersion", "protocolVersion", "nativeAppABI"]) ||
      (value.platform !== "react_native_ios" && value.platform !== "react_native_android") ||
      typeof value.nativeSDKVersion !== "string" || value.nativeSDKVersion.length === 0 ||
      value.nativeSDKVersion.length > 128 || /\p{Cc}/u.test(value.nativeSDKVersion) ||
      value.nativeAppABI !== 3 || value.contractVersion !== "1.1.0" || value.protocolVersion !== 3) {
    throw new LatchwayError(
      "protocol_response_invalid",
      `The native Latchway SDK is incompatible with JavaScript SDK ${SDK_VERSION}.`,
    );
  }
  return value as unknown as Compatibility;
}

function hasOnlyKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const expected = new Set(names);
  return Object.keys(value).every((name) => expected.has(name));
}

function parseRecord(encoded: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(encoded);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Report only a stable protocol error; native output may contain sensitive detail.
  }
  throw new LatchwayError("protocol_response_invalid", `Latchway returned invalid ${label}.`);
}

function identityFor(module: object): number {
  const existing = moduleIDs.get(module);
  if (existing !== undefined) return existing;
  const value = nextModuleID++;
  moduleIDs.set(module, value);
  return value;
}

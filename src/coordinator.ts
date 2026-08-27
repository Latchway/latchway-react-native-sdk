import { LatchwayError } from "@latchway/client";
import type { RuntimeConfiguration } from "./config.js";
import { fromNativeError, nativeUnavailable } from "./errors.js";
import { nativeModule, type NativeLatchwayModule } from "./native/bridge.js";
import type { ReactNativePlatform } from "./types.js";
import { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION } from "./version.js";

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

const entries = new Map<string, Entry>();
const moduleIDs = new WeakMap<object, number>();
let nextModuleID = 1;
let nextClientID = 1;

export async function acquire(config: RuntimeConfiguration): Promise<NativeLease> {
  let module: NativeLatchwayModule;
  try {
    module = await nativeModule();
  } catch (cause) {
    throw nativeUnavailable(cause);
  }
  const moduleID = identityFor(module);
  const key = `${moduleID}|${config.scope}`;
  const existing = entries.get(key);
  if (existing !== undefined) {
    if (existing.fingerprint !== config.fingerprint) {
      throw new LatchwayError(
        "client_configuration_invalid",
        "Conflicting Latchway native configuration is active for this application scope.",
      );
    }
    existing.references += 1;
    return lease(key, existing);
  }

  const clientID = `latchway-rn-${nextClientID++}`;
  const entry: Entry = {
    clientID,
    fingerprint: config.fingerprint,
    module,
    references: 1,
    ready: Promise.resolve({
      platform: "react_native_ios",
      nativeSDKVersion: "",
      contractVersion: "",
      protocolVersion: 0,
    }),
  };
  entry.ready = module.configure(clientID, config.nativeJSON)
    .then(parseCompatibility)
    .catch(async (cause: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      // configure may have created native state before compatibility parsing
      // failed. Disposal is idempotent on both bridges and its failure must not
      // hide the original configuration error.
      try { await module.dispose(clientID); } catch { /* preserve the original failure */ }
      throw fromNativeError(cause);
    });
  entries.set(key, entry);
  return lease(key, entry);
}

function lease(key: string, entry: Entry): NativeLease {
  let released = false;
  return {
    clientID: entry.clientID,
    module: entry.module,
    ready: entry.ready,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      entry.references -= 1;
      if (entry.references !== 0 || entries.get(key) !== entry) return;
      entries.delete(key);
      try {
        await entry.ready;
        await entry.module.dispose(entry.clientID);
      } catch (cause) {
        throw fromNativeError(cause);
      }
    },
  };
}

function parseCompatibility(encoded: string): Compatibility {
  const value = parseRecord(encoded, "native compatibility");
  if ((value.platform !== "react_native_ios" && value.platform !== "react_native_android") ||
      typeof value.nativeSDKVersion !== "string" || value.nativeSDKVersion.length === 0 ||
      value.contractVersion !== CONTRACT_VERSION || value.protocolVersion !== PROTOCOL_VERSION) {
    throw new LatchwayError(
      "protocol_response_invalid",
      `The native Latchway SDK is incompatible with JavaScript SDK ${SDK_VERSION}.`,
    );
  }
  return value as unknown as Compatibility;
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

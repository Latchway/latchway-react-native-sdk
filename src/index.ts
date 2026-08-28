import { DefaultLatchwayClient } from "./client.js";
import { configure } from "./config.js";
import type { LatchwayClient, LatchwayOptions } from "./types.js";

export { errorFromResponse, LatchwayError } from "@latchway/client";
export { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION } from "./version.js";
export type {
  AndroidKeyPolicy,
  AndroidSecurityOptions,
  AppleSecurityOptions,
  AppleSoftwareKeyFallbackPolicy,
  FetchImplementation,
  GetIdentityToken,
  IdentityTokenProvider,
  LatchwayClient,
  LatchwayFetchInit,
  LatchwayOptions,
  QuotaLimit,
  QuotaSnapshot,
  ReactNativeDiagnostics,
  ReactNativePlatform,
} from "./types.js";

export function createLatchwayClient(options: LatchwayOptions): LatchwayClient {
  return new DefaultLatchwayClient(configure(options));
}

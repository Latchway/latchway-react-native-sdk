import { DefaultLatchwayClient } from "./client.js";
import { DefaultLatchwayComponentClient } from "./component-client.js";
import { configure, configureComponent } from "./config.js";
import type {
  LatchwayClient,
  LatchwayComponentClient,
  LatchwayComponentOptions,
  LatchwayOptions,
} from "./types.js";

export { errorFromResponse, LatchwayError } from "@latchway/client";
export { LatchwayLifecycleError } from "./errors.js";
export type { LatchwayLifecycleCode } from "./errors.js";
export { Latchway, LatchwayApp, configureLatchwayApp, getLatchwayApp } from "./app.js";
export type { LatchwayAppOptions, LatchwayAppSnapshot, LatchwayIdentitySnapshot } from "./app.js";
export {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  SDK_KIND,
  SDK_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./version.js";
export type {
  AndroidKeyPolicy,
  AndroidSecurityOptions,
  AppleSecurityOptions,
  AppleSoftwareKeyFallbackPolicy,
  FetchImplementation,
  GetIdentityToken,
  IdentityTokenProvider,
  LatchwayClient,
  LatchwayComponentClient,
  LatchwayComponentOptions,
  LatchwayFetchInit,
  LatchwayFetch,
  LatchwayOptions,
  QuotaLimit,
  QuotaSnapshot,
  ReactNativeComponentDiagnostics,
  ReactNativeComponentAppleOptions,
  ReactNativeComponentTrustSource,
  ReactNativeDiagnostics,
  ReactNativeIOSComponent,
  ReactNativeIOSComponentKind,
  ReactNativeDirectAttestationComponent,
  ReactNativeDirectAttestationComponentKind,
  ReactNativePlatform,
} from "./types.js";

export function createLatchwayClient(options: LatchwayOptions): LatchwayClient {
  return new DefaultLatchwayClient(configure(options));
}

/** Creates a client only for JavaScript executing inside the signed iOS extension bundle. */
export function createLatchwayComponentClient(options: LatchwayComponentOptions): LatchwayComponentClient {
  return new DefaultLatchwayComponentClient(configureComponent(options));
}

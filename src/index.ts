import { DefaultLatchwayComponentClient } from "./component-client.js";
import { configureComponent } from "./config.js";
import type {
  LatchwayComponentClient,
  LatchwayComponentOptions,
} from "./types.js";

export { errorFromResponse, LatchwayError } from "@latchway/client";
export { LatchwayLifecycleError } from "./errors.js";
export type { LatchwayLifecycleCode } from "./errors.js";
export { Latchway, LatchwayApp, LatchwayAccount, configureLatchwayApp, getLatchwayApp } from "./app.js";
export type { LatchwayAppOptions, LatchwayAppSnapshot, LatchwayTokenInput } from "./app.js";
export { firebaseProject, jwtIdentity, bindLatchwayAuth } from "./identity.js";
export type { LatchwayIdentityConfiguration, LatchwayAuthEvent, LatchwayAuthBinding } from "./identity.js";
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
  LatchwayClient,
  LatchwayComponentClient,
  LatchwayComponentOptions,
  LatchwayFetchInit,
  LatchwayFetch,
  QuotaLimit,
  QuotaSnapshot,
  ReactNativeComponentDiagnostics,
  ReactNativeComponentTrustSource,
  ReactNativeDiagnostics,
  ReactNativeIOSComponent,
  ReactNativeIOSComponentKind,
  ReactNativePlatform,
} from "./types.js";

/** Creates a client only for JavaScript executing inside the signed iOS extension bundle. */
export function createLatchwayComponentClient(options: LatchwayComponentOptions): LatchwayComponentClient {
  return new DefaultLatchwayComponentClient(configureComponent(options));
}

import type { LatchwayError } from "@latchway/client";

export type ReactNativePlatform = "react_native_ios" | "react_native_android";

export interface IdentityTokenProvider {
  getIdentityToken(): Promise<string>;
}

export type GetIdentityToken = () => Promise<string>;

export type AppleSoftwareKeyFallbackPolicy = "disallow" | "allow";

export type AndroidKeyPolicy =
  | "hardware_backed_required"
  | "strongbox_preferred"
  | "software_allowed";

export interface AppleSecurityOptions {
  /** Fully resolved private app-ID Keychain group; required on iOS and first in the signed root app. */
  rootKeychainAccessGroup: string;
  /** Every explicit extension-shared group, scanned at exact root coordinates but never mutated. */
  legacySharedKeychainAccessGroups?: readonly string[];
  /** App Attest is enabled by default. Disabling it fails closed unless the server accepts another provider. */
  appAttestEnabled?: boolean;
  /** A non-secret namespace for caller-managed App Attest accepted-key state. */
  storageNamespace?: string;
  softwareKeyFallbackPolicy?: AppleSoftwareKeyFallbackPolicy;
}

export interface AndroidSecurityOptions {
  /** Google Cloud project number used by Play Integrity standard requests. */
  playIntegrityCloudProjectNumber?: string;
  keyPolicy?: AndroidKeyPolicy;
}

export type LatchwayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
/** @deprecated Use `LatchwayFetch`; JavaScript fetch injection is no longer a client option. */
export type FetchImplementation = LatchwayFetch;

export interface LatchwayOptions {
  baseURL: string;
  applicationID: string;
  environment: string;
  /** Supplied transiently to native operations; native consumes it only when session work needs identity. */
  getIdentityToken?: GetIdentityToken;
  identityTokenProvider?: IdentityTokenProvider;
  identityProvider?: string;
  appVersion?: string;
  apple?: AppleSecurityOptions;
  android?: AndroidSecurityOptions;
  /** Limited to loopback HTTP origins for local conformance. */
  allowInsecureLoopback?: boolean;
}

export interface LatchwayFetchInit extends RequestInit {
  latchwayFeature?: string;
}

export interface QuotaLimit {
  metric: string;
  maximum?: number;
  used?: number;
  reserved?: number;
  remaining?: number;
  resets_at?: string;
  hard: boolean;
}

export interface QuotaSnapshot {
  feature: string;
  observed_at: string;
  limits: QuotaLimit[];
}

export interface ReactNativeDiagnostics {
  sdkVersion: string;
  nativeSDKVersion: string;
  contractVersion: "1.0.0";
  protocolVersion: 2;
  platform: ReactNativePlatform;
  keyStorage: string;
  attestation: {
    support: "supported" | "unsupported" | "unknown";
    /** Provider bound to the currently accepted native session grant. */
    provider?: string;
    /** Trust level bound to the currently accepted native session grant. */
    trustLevel?: string;
    lastOperation?: string;
  };
  session: {
    state: "absent" | "establishing" | "active" | "refreshing" | "expired" | "revoked" | "failed";
    expiresAt?: string;
    refreshAvailable?: boolean;
  };
  installation: {
    id?: string;
    status?: string;
  };
  server: {
    version?: string;
    lastRequestID?: string;
  };
  lastErrorCode?: string;
}

/** iOS component kinds retained for delegated-session protocol compatibility. */
export type ReactNativeDirectAttestationComponentKind =
  | "action_extension"
  | "sso_extension";

/**
 * Public, non-secret descriptor for one independently keyed iOS component.
 *
 * `keychainAccessGroup` must be the fully resolved access group present in the
 * signed entitlements of both the containing application and the component.
 */
export interface ReactNativeDirectAttestationComponent {
  definitionID: string;
  kind: ReactNativeDirectAttestationComponentKind;
  keychainAccessGroup: string;
  requestedFeatures: readonly string[];
}

export interface ReactNativeComponentAppleOptions {
  /** The containing application's fully resolved private root Keychain group. */
  rootKeychainAccessGroup: string;
  /** Shared groups scanned for legacy root state; must include this component's exact group. */
  legacySharedKeychainAccessGroups: readonly string[];
  /** A non-secret namespace retained for component state compatibility. */
  storageNamespace?: string;
  softwareKeyFallbackPolicy?: AppleSoftwareKeyFallbackPolicy;
}

/** Configuration for JavaScript executing inside the signed iOS extension bundle. */
export interface LatchwayComponentOptions {
  baseURL: string;
  applicationID: string;
  environment: string;
  component: ReactNativeDirectAttestationComponent;
  appVersion?: string;
  apple: ReactNativeComponentAppleOptions;
  /** Limited to loopback HTTP origins for local conformance. */
  allowInsecureLoopback?: boolean;
}

export type ReactNativeComponentTrustSource =
  | "direct_attested"
  | "delegated_from_attested_root"
  | "delegated_identity_only"
  | "delegated_direct_attested"
  | "identity_only"
  | "web_risk_verified"
  | "debug";

/** Redacted native state for one independently keyed component. */
export interface ReactNativeComponentDiagnostics {
  familyID?: string;
  componentID?: string;
  definitionID: string;
  keychainAccessGroup: string;
  keyAvailable: boolean;
  keyStorage: string;
  grantAvailable: boolean;
  sessionAvailable: boolean;
  trustSource?: ReactNativeComponentTrustSource;
  trustExpiresAt?: string;
  containingAppActionRequired: boolean;
}

/**
 * A component-scoped client for React Native JavaScript executing inside an
 * iOS extension process. It has no root identity or containing-app API.
 */
export interface LatchwayComponentClient {
  readonly ready: Promise<void>;
  /**
   * Retained for API compatibility. iOS application extensions cannot call
   * the platform App Attest key-generation API, so this fails closed with
   * `attestation_unsupported`; use independently keyed delegated sessions.
   */
  establishDirectAttestation(): Promise<void>;
  diagnostics(): Promise<ReactNativeComponentDiagnostics>;
  dispose(): Promise<void>;
}

export interface LatchwayClient {
  /** Canonical gateway origin for framework clients that require an explicit base URL. */
  readonly gatewayURL: string;
  /** Resolves after the native runtime proves contract compatibility. */
  readonly ready: Promise<void>;
  fetch(input: RequestInfo | URL, init?: LatchwayFetchInit): Promise<Response>;
  /** Returns a WHATWG fetch-shaped function permanently bound to one Latchway feature. */
  fetchFor(feature: string): LatchwayFetch;
  quota(feature: string): Promise<QuotaSnapshot>;
  diagnostics(): Promise<ReactNativeDiagnostics>;
  /** Explicitly rotates the native session credentials for this installation. */
  refresh(): Promise<void>;
  /** Revokes this installation while leaving independently provisioned family components addressable. */
  revokeCurrentInstallation(): Promise<void>;
  /** Revokes the complete Installation Family and retires the root native key and session state. */
  revokeCurrentInstallationFamily(): Promise<void>;
  /** Releases this JavaScript instance. Secure installation state remains until revocation. */
  dispose(): Promise<void>;
}

export type { LatchwayError };

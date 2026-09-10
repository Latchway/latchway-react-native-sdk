import type { LatchwayError } from "@latchway/client";

export type ReactNativePlatform = "react_native_ios" | "react_native_android";

export type AppleSoftwareKeyFallbackPolicy = "disallow" | "allow";

export type AndroidKeyPolicy =
  | "hardware_backed_required"
  | "strongbox_preferred"
  | "software_allowed";

export interface AppleSecurityOptions {
  /** Fully resolved private app-ID Keychain group; required on iOS and first in the signed root app. */
  rootKeychainAccessGroup: string;
  /** App Attest is enabled by default. Disabling it fails closed unless the server accepts another provider. */
  appAttestEnabled?: boolean;
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
  contractVersion: "1.1.0";
  protocolVersion: 3;
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

/** Native iOS execution boundaries that can hold delegated component sessions. */
export type ReactNativeIOSComponentKind =
  | "widget"
  | "share_extension"
  | "app_intent_extension"
  | "notification_service_extension"
  | "action_extension"
  | "sso_extension";

/**
 * Public, non-secret descriptor used by the containing application to prepare
 * and retire one independently keyed native iOS component.
 */
export interface ReactNativeIOSComponent {
  definitionID: string;
  kind: ReactNativeIOSComponentKind;
  keychainAccessGroup: string;
  requestedFeatures: readonly string[];
}

/** Configuration for JavaScript executing inside the signed iOS extension bundle. */
export interface LatchwayComponentOptions {
  baseURL: string;
  applicationID: string;
  environment: string;
  component: ReactNativeIOSComponent;
  /** Opaque non-secret account/generation handoff from the containing native account. */
  account: string;
  appVersion?: string;
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
  diagnostics(): Promise<ReactNativeComponentDiagnostics>;
  dispose(): Promise<void>;
}

export interface LatchwayClient {
  /** Offline account retirement. Requires a client created by a native-owned LatchwayApp. */
  logout(): Promise<void>;
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
  /**
   * Creates or restores independent native iOS component keys and delegated
   * provisioning grants. Descriptor fields are public; credentials remain native.
   */
  /** Captures the current account for a separately keyed signed iOS extension. No credential is exported. */
  componentAccount(): Promise<string>;
  prepareComponents(components: readonly ReactNativeIOSComponent[]): Promise<ReactNativeComponentDiagnostics[]>;
  /** Replaces one component key and its delegated provisioning grant. */
  replaceComponent(component: ReactNativeIOSComponent): Promise<ReactNativeComponentDiagnostics>;
  /** Reads redacted local state for one descriptor without using root identity. */
  componentDiagnostics(component: ReactNativeIOSComponent): Promise<ReactNativeComponentDiagnostics>;
  /** Revokes and erases one native iOS component without affecting its siblings. */
  revokeComponent(component: ReactNativeIOSComponent): Promise<void>;
  /** Revokes this installation while leaving independently provisioned family components addressable. */
  revokeCurrentInstallation(): Promise<void>;
  /**
   * Revokes the complete Installation Family and retires the root plus every
   * native-registered component, including registrations from earlier app
   * launches.
   */
  revokeCurrentInstallationFamily(): Promise<void>;
  /** Releases this JavaScript instance. Secure installation state remains until revocation. */
  dispose(): Promise<void>;
}

export type { LatchwayError };

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

export type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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
  fetch?: FetchImplementation;
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
  contractVersion: "0.2.0";
  protocolVersion: 1;
  platform: ReactNativePlatform;
  keyStorage: string;
  attestation: {
    support: "supported" | "unsupported" | "unknown";
    provider?: string;
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

export interface LatchwayClient {
  /** Resolves after the native runtime proves contract compatibility. */
  readonly ready: Promise<void>;
  fetch(input: RequestInfo | URL, init?: LatchwayFetchInit): Promise<Response>;
  authorize(request: Request, feature: string): Promise<Request>;
  quota(feature: string): Promise<QuotaSnapshot>;
  diagnostics(): Promise<ReactNativeDiagnostics>;
  revokeCurrentInstallation(): Promise<void>;
  /** Releases this JavaScript instance. Secure installation state remains until revocation. */
  dispose(): Promise<void>;
}

export type { LatchwayError };

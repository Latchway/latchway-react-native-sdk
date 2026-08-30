import { LatchwayError } from "@latchway/client";
import type {
  LatchwayComponentOptions,
  LatchwayOptions,
  ReactNativeDirectAttestationComponent,
} from "./types.js";
import { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION } from "./version.js";

export interface RuntimeConfiguration {
  baseURL: URL;
  applicationID: string;
  environment: string;
  identityProvider: string;
  appVersion: string;
  getIdentityToken: () => Promise<string>;
  nativeJSON: string;
  fingerprint: string;
  scope: string;
}

export interface RuntimeComponentConfiguration {
  nativeJSON: string;
  componentJSON: string;
  fingerprint: string;
  scope: string;
  component: ReactNativeDirectAttestationComponent;
}

export function configure(options: LatchwayOptions): RuntimeConfiguration {
  const baseURL = parseBaseURL(options.baseURL, options.allowInsecureLoopback === true);
  const applicationID = applicationResourceID(options.applicationID);
  const environment = identifier(options.environment, "environment");
  const identityProvider = identifier(options.identityProvider ?? "custom_jwt", "identityProvider");
  const appVersion = boundedString(options.appVersion ?? SDK_VERSION, "appVersion", 128);
  const getIdentityToken = tokenProvider(options);
  const storageNamespace = options.apple?.storageNamespace;
  if (storageNamespace !== undefined) boundedString(storageNamespace, "apple.storageNamespace", 128);
  const appleFallback = options.apple?.softwareKeyFallbackPolicy ?? "disallow";
  if (appleFallback !== "disallow" && appleFallback !== "allow") {
    throw new LatchwayError("client_configuration_invalid", "apple.softwareKeyFallbackPolicy is invalid.");
  }
  const androidKeyPolicy = options.android?.keyPolicy ?? "strongbox_preferred";
  if (!new Set(["hardware_backed_required", "strongbox_preferred", "software_allowed"]).has(androidKeyPolicy)) {
    throw new LatchwayError("client_configuration_invalid", "android.keyPolicy is invalid.");
  }
  const projectNumber = options.android?.playIntegrityCloudProjectNumber;
  if (projectNumber !== undefined &&
      (!/^[1-9][0-9]{5,18}$/u.test(projectNumber) || BigInt(projectNumber) > 9_223_372_036_854_775_807n)) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "android.playIntegrityCloudProjectNumber must be a decimal Google Cloud project number.",
    );
  }

  const nativeConfiguration = {
    baseURL: baseURL.href,
    applicationID,
    environment,
    identityProvider,
    appVersion,
    sdkVersion: SDK_VERSION,
    contractVersion: CONTRACT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    allowInsecureLoopback: options.allowInsecureLoopback === true,
    apple: {
      appAttestEnabled: options.apple?.appAttestEnabled ?? true,
      softwareKeyFallbackPolicy: appleFallback,
      ...(storageNamespace === undefined ? {} : { storageNamespace }),
    },
    android: {
      keyPolicy: androidKeyPolicy,
      ...(projectNumber === undefined ? {} : { playIntegrityCloudProjectNumber: projectNumber }),
    },
  };
  const nativeJSON = JSON.stringify(nativeConfiguration);
  return {
    baseURL,
    applicationID,
    environment,
    identityProvider,
    appVersion,
    getIdentityToken,
    nativeJSON,
    fingerprint: nativeJSON,
    scope: `${baseURL.origin}|${applicationID}|${environment}`,
  };
}

export function configureComponent(options: LatchwayComponentOptions): RuntimeComponentConfiguration {
  const baseURL = parseBaseURL(options.baseURL, options.allowInsecureLoopback === true);
  const applicationID = applicationResourceID(options.applicationID);
  const environment = identifier(options.environment, "environment");
  const appVersion = boundedString(options.appVersion ?? SDK_VERSION, "appVersion", 128);
  const component = validateDirectAttestationComponent(options.component);
  const storageNamespace = options.apple?.storageNamespace;
  if (storageNamespace !== undefined) boundedString(storageNamespace, "apple.storageNamespace", 128);
  const appleFallback = options.apple?.softwareKeyFallbackPolicy ?? "disallow";
  if (appleFallback !== "disallow" && appleFallback !== "allow") {
    throw new LatchwayError("client_configuration_invalid", "apple.softwareKeyFallbackPolicy is invalid.");
  }
  const nativeJSON = JSON.stringify({
    baseURL: baseURL.href,
    applicationID,
    environment,
    appVersion,
    sdkVersion: SDK_VERSION,
    contractVersion: CONTRACT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    allowInsecureLoopback: options.allowInsecureLoopback === true,
    apple: {
      softwareKeyFallbackPolicy: appleFallback,
      ...(storageNamespace === undefined ? {} : { storageNamespace }),
    },
  });
  const componentJSON = JSON.stringify(component);
  return {
    nativeJSON,
    componentJSON,
    fingerprint: `${nativeJSON}|${componentJSON}`,
    scope: `${baseURL.origin}|${applicationID}|${environment}|${component.definitionID}`,
    component,
  };
}

function applicationResourceID(value: string): string {
  const applicationID = boundedString(value, "applicationID", 30);
  if (!/^app_[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(applicationID)) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "applicationID must be the canonical app_ resource ID returned by the Admin API.",
    );
  }
  return applicationID;
}

function tokenProvider(options: LatchwayOptions): () => Promise<string> {
  if (options.getIdentityToken !== undefined && options.identityTokenProvider !== undefined) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "Configure either getIdentityToken or identityTokenProvider, not both.",
    );
  }
  if (typeof options.getIdentityToken === "function") return options.getIdentityToken;
  if (typeof options.identityTokenProvider?.getIdentityToken === "function") {
    return options.identityTokenProvider.getIdentityToken.bind(options.identityTokenProvider);
  }
  throw new LatchwayError("client_configuration_invalid", "getIdentityToken is required.");
}

function parseBaseURL(value: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new LatchwayError("client_configuration_invalid", "baseURL must be an absolute URL.", { cause });
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.pathname !== "/") {
    throw new LatchwayError(
      "client_configuration_invalid",
      "baseURL must identify an origin without credentials, path, query, or fragment.",
    );
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowInsecureLoopback && loopback && url.protocol === "http:")) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "baseURL must use HTTPS; HTTP is limited to explicitly enabled loopback conformance.",
    );
  }
  return new URL(url.origin);
}

function identifier(value: string, field: string): string {
  if (!/^[a-z][a-z0-9_-]{0,62}$/u.test(value)) {
    throw new LatchwayError("client_configuration_invalid", `${field} must be a lowercase Latchway identifier.`);
  }
  return value;
}

function boundedString(value: string, field: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /\p{Cc}/u.test(value)) {
    throw new LatchwayError(
      "client_configuration_invalid",
      `${field} must contain between 1 and ${maximum} printable characters.`,
    );
  }
  return value;
}

function validateDirectAttestationComponent(value: ReactNativeDirectAttestationComponent): ReactNativeDirectAttestationComponent {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["definitionID", "kind", "keychainAccessGroup", "requestedFeatures"]) ||
      typeof value.definitionID !== "string" || !validIdentifier(value.definitionID) ||
      (value.kind !== "action_extension" && value.kind !== "sso_extension") ||
      typeof value.keychainAccessGroup !== "string" ||
      !/^[A-Za-z0-9._-]{1,255}$/u.test(value.keychainAccessGroup) ||
      !Array.isArray(value.requestedFeatures) || value.requestedFeatures.length === 0 ||
      value.requestedFeatures.length > 256 ||
      !value.requestedFeatures.every((feature) => typeof feature === "string" && validIdentifier(feature)) ||
      new Set(value.requestedFeatures).size !== value.requestedFeatures.length) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "The direct-attestation component descriptor is invalid.",
    );
  }
  return {
    definitionID: value.definitionID,
    kind: value.kind,
    keychainAccessGroup: value.keychainAccessGroup,
    requestedFeatures: Array.from(value.requestedFeatures as string[]),
  };
}

function validIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,62}$/u.test(value);
}

function hasOnlyKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const expected = new Set(names);
  return Object.keys(value).every((name) => expected.has(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { LatchwayError } from "@latchway/client";
import type {
  LatchwayComponentOptions,
  LatchwayOptions,
  ReactNativeDirectAttestationComponent,
  ReactNativeIOSComponent,
} from "./types.js";
import { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION } from "./version.js";

export interface RuntimeConfiguration {
  baseURL: URL;
  applicationID: string;
  environment: string;
  identityProvider: string;
  appVersion: string;
  getIdentityToken: () => Promise<string>;
  appleSharedKeychainAccessGroups: readonly string[];
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
  const rootKeychainAccessGroup = options.apple?.rootKeychainAccessGroup;
  if (options.apple !== undefined && rootKeychainAccessGroup === undefined) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "apple.rootKeychainAccessGroup is required for an Apple configuration.",
    );
  }
  const legacySharedKeychainAccessGroups = options.apple?.legacySharedKeychainAccessGroups ?? [];
  if (rootKeychainAccessGroup !== undefined) {
    validateRootKeychainAccessGroups(rootKeychainAccessGroup, legacySharedKeychainAccessGroups);
  }
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
      ...(rootKeychainAccessGroup === undefined ? {} : {
        rootKeychainAccessGroup,
        legacySharedKeychainAccessGroups: Array.from(legacySharedKeychainAccessGroups),
      }),
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
    appleSharedKeychainAccessGroups: Array.from(legacySharedKeychainAccessGroups),
    nativeJSON,
    fingerprint: nativeJSON,
    scope: `${baseURL.origin}|${applicationID}|${environment}`,
  };
}

export function encodeIOSComponentDescriptors(
  values: readonly ReactNativeIOSComponent[],
  sharedKeychainAccessGroups: readonly string[],
): string {
  if (!runtimeArray(values) || values.length === 0 || values.length > 256) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "At least one native iOS component descriptor is required.",
    );
  }
  const components = values.map((value) => validateIOSComponent(value, sharedKeychainAccessGroups));
  if (new Set(components.map((component) => component.definitionID)).size !== components.length) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "Native iOS component definition IDs must be unique in one operation.",
    );
  }
  return boundedComponentJSON(components);
}

export function encodeIOSComponentDescriptor(
  value: ReactNativeIOSComponent,
  sharedKeychainAccessGroups: readonly string[],
): string {
  return boundedComponentJSON(validateIOSComponent(value, sharedKeychainAccessGroups));
}

function boundedComponentJSON(value: ReactNativeIOSComponent | readonly ReactNativeIOSComponent[]): string {
  const encoded = JSON.stringify(value);
  // Every validated descriptor field is ASCII, so UTF-16 length is the exact
  // UTF-8 byte length accepted by the native bridge.
  if (encoded.length > 65_536) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "Native iOS component descriptors exceed the 64 KiB bridge limit.",
    );
  }
  return encoded;
}

export function configureComponent(options: LatchwayComponentOptions): RuntimeComponentConfiguration {
  const baseURL = parseBaseURL(options.baseURL, options.allowInsecureLoopback === true);
  const applicationID = applicationResourceID(options.applicationID);
  const environment = identifier(options.environment, "environment");
  const appVersion = boundedString(options.appVersion ?? SDK_VERSION, "appVersion", 128);
  const component = validateDirectAttestationComponent(options.component);
  if (options.apple === undefined) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "apple root Keychain configuration is required for an iOS component.",
    );
  }
  validateRootKeychainAccessGroups(
    options.apple.rootKeychainAccessGroup,
    options.apple.legacySharedKeychainAccessGroups,
  );
  if (!options.apple.legacySharedKeychainAccessGroups.includes(component.keychainAccessGroup)) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "The component Keychain group must be an explicit shared group of the containing root application.",
    );
  }
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
      rootKeychainAccessGroup: options.apple.rootKeychainAccessGroup,
      legacySharedKeychainAccessGroups: Array.from(options.apple.legacySharedKeychainAccessGroups),
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

function validateRootKeychainAccessGroups(root: string, legacy: readonly string[]): void {
  if (!concreteKeychainAccessGroup(root)) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "apple.rootKeychainAccessGroup must be a fully resolved concrete dotted access group.",
    );
  }
  if (!Array.isArray(legacy) || !legacy.every(concreteKeychainAccessGroup) ||
      legacy.includes(root) || new Set(legacy).size !== legacy.length) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "apple.legacySharedKeychainAccessGroups must contain distinct concrete groups other than the root group.",
    );
  }
}

function concreteKeychainAccessGroup(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 255 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(value);
}

function validateDirectAttestationComponent(value: ReactNativeDirectAttestationComponent): ReactNativeDirectAttestationComponent {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["definitionID", "kind", "keychainAccessGroup", "requestedFeatures"]) ||
      typeof value.definitionID !== "string" || !validIdentifier(value.definitionID) ||
      (value.kind !== "action_extension" && value.kind !== "sso_extension") ||
      !concreteKeychainAccessGroup(value.keychainAccessGroup) ||
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

function validateIOSComponent(
  value: ReactNativeIOSComponent,
  sharedKeychainAccessGroups: readonly string[],
): ReactNativeIOSComponent {
  const kinds = new Set([
    "widget",
    "share_extension",
    "app_intent_extension",
    "notification_service_extension",
    "action_extension",
    "sso_extension",
  ]);
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["definitionID", "kind", "keychainAccessGroup", "requestedFeatures"]) ||
      typeof value.definitionID !== "string" || !validIdentifier(value.definitionID) ||
      typeof value.kind !== "string" || !kinds.has(value.kind) ||
      !concreteKeychainAccessGroup(value.keychainAccessGroup) ||
      !sharedKeychainAccessGroups.includes(value.keychainAccessGroup) ||
      !Array.isArray(value.requestedFeatures) || value.requestedFeatures.length === 0 ||
      value.requestedFeatures.length > 256 ||
      !value.requestedFeatures.every((feature) => typeof feature === "string" && validIdentifier(feature)) ||
      new Set(value.requestedFeatures).size !== value.requestedFeatures.length) {
    throw new LatchwayError(
      "client_configuration_invalid",
      "The native iOS component descriptor is invalid or its Keychain group is not explicitly shared.",
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

function runtimeArray(value: unknown): boolean {
  return Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const expected = new Set(names);
  return Object.keys(value).every((name) => expected.has(name));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

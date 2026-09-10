import { LatchwayError } from "@latchway/client";
import type {
  LatchwayComponentOptions,
  ReactNativeIOSComponent,
} from "./types.js";
import {
  SDK_VERSION,
} from "./version.js";

export interface RuntimeConfiguration {
  baseURL: URL;
  appleSharedKeychainAccessGroups: readonly string[];
}

export interface RuntimeComponentConfiguration {
  nativeJSON: string;
  componentJSON: string;
  fingerprint: string;
  scope: string;
  component: ReactNativeIOSComponent;
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
  if (Object.keys(options).some(key => !["baseURL", "applicationID", "environment", "component", "account", "appVersion", "allowInsecureLoopback"].includes(key))) {
    throw new LatchwayError("client_configuration_invalid", "The component configuration contains unsupported options.");
  }
  const baseURL = parseBaseURL(options.baseURL, options.allowInsecureLoopback === true);
  const applicationID = applicationResourceID(options.applicationID);
  const environment = identifier(options.environment, "environment");
  const appVersion = boundedString(options.appVersion ?? SDK_VERSION, "appVersion", 128);
  const component = validateIOSComponent(options.component, [options.component?.keychainAccessGroup]);
  if (typeof options.account !== "string" || options.account.length > 4096 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(options.account)) {
    throw new LatchwayError("client_configuration_invalid", "A captured native component account is required.");
  }
  const nativeJSON = JSON.stringify({
    baseURL: baseURL.href,
    applicationID,
    environment,
    appVersion,
    sdkVersion: SDK_VERSION,
    contractVersion: "1.1.0",
    protocolVersion: 3,
    nativeAppABI: 3,
    allowInsecureLoopback: options.allowInsecureLoopback === true,
    account: options.account,
  });
  const componentJSON = JSON.stringify(component);
  return {
    nativeJSON,
    componentJSON,
    fingerprint: `${nativeJSON}|${componentJSON}`,
    scope: `${baseURL.origin}|${applicationID}|${environment}|${component.definitionID}|${options.account}`,
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

function concreteKeychainAccessGroup(value: unknown): value is string {
  return typeof value === "string" && value.length >= 3 && value.length <= 255 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/u.test(value);
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

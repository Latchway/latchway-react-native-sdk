import { LatchwayError } from "@latchway/client";
import type { FetchImplementation, LatchwayOptions } from "./types.js";
import { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION } from "./version.js";

export interface RuntimeConfiguration {
  baseURL: URL;
  applicationID: string;
  environment: string;
  identityProvider: string;
  appVersion: string;
  getIdentityToken: () => Promise<string>;
  fetch: FetchImplementation;
  nativeJSON: string;
  fingerprint: string;
  scope: string;
}

export function configure(options: LatchwayOptions): RuntimeConfiguration {
  const baseURL = parseBaseURL(options.baseURL, options.allowInsecureLoopback === true);
  const applicationID = boundedString(options.applicationID, "applicationID", 128);
  const environment = identifier(options.environment, "environment");
  const identityProvider = identifier(options.identityProvider ?? "custom_jwt", "identityProvider");
  const appVersion = boundedString(options.appVersion ?? SDK_VERSION, "appVersion", 128);
  const getIdentityToken = tokenProvider(options);
  const fallbackFetch = Reflect.get(globalThis, "fetch") as FetchImplementation | undefined;
  const fetchImplementation = options.fetch ?? fallbackFetch?.bind(globalThis);
  if (typeof fetchImplementation !== "function") {
    throw new LatchwayError("client_configuration_invalid", "A Fetch API implementation is required.");
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
    fetch: fetchImplementation,
    nativeJSON,
    fingerprint: nativeJSON,
    scope: `${baseURL.origin}|${applicationID}|${environment}`,
  };
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

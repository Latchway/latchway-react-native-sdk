import { LatchwayError } from "@latchway/client";
import type { RuntimeComponentConfiguration } from "./config.js";
import { acquireComponent, type NativeLease } from "./coordinator.js";
import { fromNativeError } from "./errors.js";
import { assertNoCredentialFields } from "./native-output.js";
import type {
  LatchwayComponentClient,
  ReactNativeComponentDiagnostics,
  ReactNativeComponentTrustSource,
  ReactNativeDirectAttestationComponent,
  ReactNativeIOSComponent,
} from "./types.js";

const componentTrustSources = new Set<ReactNativeComponentTrustSource>([
  "direct_attested",
  "delegated_from_attested_root",
  "delegated_identity_only",
  "delegated_direct_attested",
  "identity_only",
  "web_risk_verified",
  "debug",
]);

let nextComponentOperationID = 1;

export class DefaultLatchwayComponentClient implements LatchwayComponentClient {
  readonly ready: Promise<void>;
  private readonly lease: Promise<NativeLease>;
  private disposed = false;

  constructor(private readonly config: RuntimeComponentConfiguration) {
    this.lease = acquireComponent(config);
    this.ready = this.lease.then(async (lease) => { await lease.ready; });
  }

  async establishDirectAttestation(): Promise<void> {
    this.assertActive();
    const lease = await this.lease;
    await lease.ready;
    const operationID = makeComponentOperationID();
    try {
      await lease.module.establishDirectAttestation(lease.clientID, operationID);
    } catch (cause) {
      throw fromNativeError(cause);
    }
  }

  async diagnostics(): Promise<ReactNativeComponentDiagnostics> {
    this.assertActive();
    const lease = await this.lease;
    await lease.ready;
    const operationID = makeComponentOperationID();
    let encoded: string;
    try {
      encoded = await lease.module.componentDiagnostics(lease.clientID, operationID);
    } catch (cause) {
      throw fromNativeError(cause);
    }
    return parseComponentDiagnostics(encoded, this.config.component);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const lease = await this.lease;
    await lease.release();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new LatchwayError("client_configuration_invalid", "This Latchway component client has been disposed.");
    }
  }
}

export function parseComponentDiagnostics(
  encoded: string,
  component: ReactNativeDirectAttestationComponent | ReactNativeIOSComponent,
): ReactNativeComponentDiagnostics {
  const value = parseRecord(encoded);
  assertNoCredentialFields(value);
  if (!hasOnlyKeys(value, [
    "familyID", "componentID", "definitionID", "keychainAccessGroup", "keyAvailable", "keyStorage",
    "grantAvailable", "sessionAvailable", "trustSource", "trustExpiresAt", "containingAppActionRequired",
  ]) || value.definitionID !== component.definitionID ||
      value.keychainAccessGroup !== component.keychainAccessGroup ||
      typeof value.keyAvailable !== "boolean" || typeof value.keyStorage !== "string" ||
      value.keyStorage.length === 0 || value.keyStorage.length > 128 || /\p{Cc}/u.test(value.keyStorage) ||
      typeof value.grantAvailable !== "boolean" || typeof value.sessionAvailable !== "boolean" ||
      typeof value.containingAppActionRequired !== "boolean") {
    throw invalidDiagnostics();
  }
  const familyID = optionalID(value.familyID, /^fam_[A-Za-z0-9_-]{16,128}$/u);
  const componentID = optionalID(value.componentID, /^cmp_[A-Za-z0-9_-]{16,128}$/u);
  const trustExpiresAt = optionalString(value.trustExpiresAt);
  if (trustExpiresAt !== undefined && !validRFC3339(trustExpiresAt)) throw invalidDiagnostics();
  const trustSource = optionalString(value.trustSource);
  if (trustSource !== undefined && !componentTrustSources.has(trustSource as ReactNativeComponentTrustSource)) {
    throw invalidDiagnostics();
  }
  return {
    ...(familyID === undefined ? {} : { familyID }),
    ...(componentID === undefined ? {} : { componentID }),
    definitionID: component.definitionID,
    keychainAccessGroup: component.keychainAccessGroup,
    keyAvailable: value.keyAvailable,
    keyStorage: value.keyStorage,
    grantAvailable: value.grantAvailable,
    sessionAvailable: value.sessionAvailable,
    ...(trustSource === undefined ? {} : { trustSource: trustSource as ReactNativeComponentTrustSource }),
    ...(trustExpiresAt === undefined ? {} : { trustExpiresAt }),
    containingAppActionRequired: value.containingAppActionRequired,
  };
}

function parseRecord(encoded: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(encoded);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Never reflect native output into the public error.
  }
  throw invalidDiagnostics();
}

function optionalID(value: unknown, pattern: RegExp): string | undefined {
  const result = optionalString(value);
  if (result !== undefined && !pattern.test(result)) throw invalidDiagnostics();
  return result;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw invalidDiagnostics();
  }
  return value;
}

function validRFC3339(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function hasOnlyKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const expected = new Set(names);
  return Object.keys(value).every((name) => expected.has(name));
}

function invalidDiagnostics(): LatchwayError {
  return new LatchwayError("protocol_response_invalid", "Latchway returned invalid component diagnostics.");
}

function makeComponentOperationID(): string {
  return `component-op-${nextComponentOperationID++}`;
}

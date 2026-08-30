import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  NativeModules,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Config from "react-native-config";
import firebaseApp from "@react-native-firebase/app";
import firebaseAuth from "@react-native-firebase/auth";
import {
  createLatchwayClient,
  LatchwayError,
  type LatchwayClient,
} from "@latchway/react-native";
import { freshClientAfterRevocation } from "./evidence-client";

const deployment = {
  baseURL: required("LATCHWAY_BASE_URL"),
  applicationID: required("LATCHWAY_APPLICATION_ID"),
  packageOrBundleIdentifier: required("LATCHWAY_PACKAGE_OR_BUNDLE_IDENTIFIER"),
  environment: required("LATCHWAY_ENVIRONMENT"),
  feature: required("LATCHWAY_FEATURE"),
  errorMappingFeature: required("LATCHWAY_ERROR_MAPPING_FEATURE"),
  model: required("LATCHWAY_MODEL"),
  googleCloudProjectNumber: Platform.OS === "android"
    ? required("LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER")
    : undefined,
  rootKeychainAccessGroup: Platform.OS === "ios"
    ? required("LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP")
    : undefined,
  legacySharedKeychainAccessGroups: Platform.OS === "ios"
    ? configuredKeychainAccessGroups("LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS")
    : [],
};

let physicalIdentityBootstrap: Promise<void> | undefined;
let firebaseInitialization: Promise<void> | undefined;

function makeClient(): LatchwayClient {
  return createLatchwayClient({
    baseURL: deployment.baseURL,
    applicationID: deployment.applicationID,
    environment: deployment.environment,
    identityProvider: "firebase",
    getIdentityToken: physicalConformanceEnabled()
      ? physicalIdentityToken
      : async () => {
        await ensureFirebaseApp();
        const user = firebaseAuth().currentUser;
        if (user === null) throw new Error("Sign in with Firebase before calling Latchway.");
        return user.getIdToken();
      },
    ...(deployment.googleCloudProjectNumber === undefined ? {} : {
      android: { playIntegrityCloudProjectNumber: deployment.googleCloudProjectNumber },
    }),
    ...(deployment.rootKeychainAccessGroup === undefined ? {} : {
      apple: {
        rootKeychainAccessGroup: deployment.rootKeychainAccessGroup,
        legacySharedKeychainAccessGroups: deployment.legacySharedKeychainAccessGroups,
      },
    }),
  });
}

export default function App(): React.JSX.Element {
  const [input, setInput] = useState("Plan a focused afternoon.");
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const [client, setClient] = useState(makeClient);

  useEffect(() => () => { void client.dispose(); }, [client]);

  const evidenceStarted = useRef(false);

  const send = async (): Promise<void> => {
    setBusy(true);
    setOutput("");
    try {
      const response = await client.fetch("/v1/chat/completions", {
        method: "POST",
        latchwayFeature: deployment.feature,
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: deployment.model,
          messages: [{ role: "user", content: input }],
          stream: true,
        }),
      });
      if (!response.ok) throw new Error(`Gateway returned HTTP ${response.status}.`);
      setStatus("Streaming response");
      await consumeStream(response, setOutput);
      setStatus(`Completed · request ${response.headers.get("X-Latchway-Request-ID") ?? "not supplied"}`);
    } catch (error) {
      setStatus(safeError(error));
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (): Promise<void> => {
    setBusy(true);
    try {
      const [quota, diagnostics] = await Promise.all([
        client.quota(deployment.feature),
        client.diagnostics(),
      ]);
      setOutput(JSON.stringify({ quota, diagnostics }, null, 2));
      setStatus("Loaded redacted diagnostics");
    } catch (error) {
      setStatus(safeError(error));
    } finally {
      setBusy(false);
    }
  };

  const runPhysicalEvidence = async (): Promise<void> => {
    setBusy(true);
    setOutput("");
    const startedAt = new Date().toISOString();
    const tests: EvidenceTest[] = [];
    let diagnostics: Awaited<ReturnType<typeof client.diagnostics>> | undefined;
    let measuredClient: LatchwayClient | undefined;
    let physicalCleanupComplete = false;
    try {
      const sink = evidenceSink();
      const runID = await sink.runID();
      const pins = await physicalPins();
      if (physicalConformanceEnabled()) {
        // The collector removes ordinary application state before this launch,
        // but iOS uninstall does not guarantee Keychain or Secure Enclave
        // removal. Require a fresh Firebase state first, then explicitly revoke
        // any prior native Latchway installation before measuring a replacement.
        // The one-use custom-token grant is consumed only if revocation or the
        // replacement needs identity.
        await ensureFirebaseApp();
        if (firebaseAuth().currentUser !== null) {
          throw new Error("Protected physical evidence requires a fresh Firebase identity state.");
        }
      }
      measuredClient = await freshClientAfterRevocation(client, makeClient);
      setClient(measuredClient);

      const firstResponse = await measuredClient.fetch("/v1/chat/completions", {
        method: "POST",
        latchwayFeature: deployment.feature,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: deployment.model,
          messages: [{ role: "user", content: "Return the word conformance." }],
          stream: false,
        }),
      });
      const first = await inspectBounded(firstResponse, 65_536);
      tests.push(httpTest("dpop_authorized_request", first, first.status >= 200 && first.status < 300));

      // The public bridge deliberately has no authorization-envelope escape
      // hatch. Replay, proof mutation, credential rotation, protocol mutation,
      // and post-revocation enforcement are imported by the protected
      // finalizer from the exact hash-pinned native evidence report. JavaScript
      // proves only behavior that crosses the opaque production bridge.

      try {
        await measuredClient.quota(deployment.errorMappingFeature);
        tests.push({ id: "canonical_error_mapping", status: "failed", duration_ms: 0 });
      } catch (error) {
        const mapped = error instanceof LatchwayError;
        const mappedRequestID = mapped ? safeRequestID(error.requestID ?? null) : undefined;
        tests.push({
          id: "canonical_error_mapping",
          status: mapped && error.code === "feature_not_found" && error.status === 404 &&
            mappedRequestID !== undefined ? "passed" : "failed",
          duration_ms: 0,
          ...(mapped && typeof error.status === "number" ? { http_status: error.status } : {}),
          ...(mapped ? { error_code: error.code, mapped_error_type: "react_native_latchway_error" } : {}),
          ...(mappedRequestID === undefined ? {} : { request_id: mappedRequestID }),
        });
      }

      const stream = await measuredClient.fetch("/v1/chat/completions", {
        method: "POST",
        latchwayFeature: deployment.feature,
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: deployment.model,
          messages: [{ role: "user", content: "Return the word conformance." }],
          stream: true,
        }),
      });
      const streamedBytes = await consumeStreamBytes(stream, 1_048_576);
      tests.push(httpTest(
        "streamed_request",
        {
          status: stream.status,
          byteCount: streamedBytes,
          ...optionalRequestID(stream.headers.get("X-Latchway-Request-ID")),
        },
        stream.ok && streamedBytes > 0,
      ));

      const quota = await measuredClient.quota(deployment.feature);
      tests.push(booleanTest("quota", quota.feature === deployment.feature && quota.limits.length > 0));
      diagnostics = await measuredClient.diagnostics();
      const expectedPlatform = Platform.OS === "ios" ? "react_native_ios" : "react_native_android";
      const expectedProvider = Platform.OS === "ios" ? "app_attest" : "play_integrity";
      const hardware = Platform.OS === "ios"
        ? diagnostics.keyStorage === "secure_enclave"
        : ["strongbox", "trusted_execution_environment", "unknown_secure_hardware"].includes(diagnostics.keyStorage);
      // Core normalizes App Attest to the application-scoped `app_verified`
      // level. Play Integrity retains its device strength. Do not accept one
      // provider's normalized level as evidence for the other provider.
      const trustedLevel = Platform.OS === "ios"
        ? diagnostics.attestation.trustLevel === "app_verified"
        : diagnostics.attestation.trustLevel === "device_verified" ||
          diagnostics.attestation.trustLevel === "strong_device_verified";
      tests.push(booleanTest(
        Platform.OS === "ios" ? "app_attest_session" : "play_integrity_session",
        diagnostics.platform === expectedPlatform && diagnostics.attestation.provider === expectedProvider &&
          diagnostics.session.state === "active" && trustedLevel,
      ));
      tests.push(booleanTest(
        Platform.OS === "ios" ? "secure_enclave_key" : "hardware_backed_key",
        hardware,
      ));

      if (physicalConformanceEnabled()) {
        // A passing record must not leave the measured installation or its
        // derived Firebase identity reusable. Revoke Latchway first because
        // revocation may require the current identity token.
        await measuredClient.revokeCurrentInstallation();
        await firebaseAuth().signOut();
        physicalIdentityBootstrap = undefined;
        physicalCleanupComplete = true;
      }
      // Defer this required marker until terminal cleanup succeeds. Any cleanup
      // error therefore produces a bounded record with a failed bridge check.
      tests.push(booleanTest("react_native_bridge", true));

      const requiredTests = rawEvidenceTests().map((identifier) =>
        tests.find((test) => test.id === identifier) ?? booleanTest(identifier, false)
      );
      const record = {
        schema_version: "latchway.react-native-device-run.v2",
        platform: Platform.OS === "ios"
          ? "react_native_ios_app_attest"
          : "react_native_android_play_integrity",
        run: {
          id: runID,
          mode: "release",
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        },
        gateway_version: diagnostics.server.version ?? "unknown",
        native: {
          provider: diagnostics.attestation.provider ?? "unverified",
          trust_level: diagnostics.attestation.trustLevel ?? "none",
          key_storage: diagnostics.keyStorage,
          native_sdk_version: diagnostics.nativeSDKVersion,
          native_evidence_sha256: pins.native_evidence_sha256,
          session_state: diagnostics.session.state,
          new_architecture: true,
        },
        pins,
        tests: requiredTests,
        redaction: redactionDeclaration(),
      };
      await sink.write(JSON.stringify(record));
      setStatus(requiredTests.every((test) => test.status === "passed")
        ? "Device suite completed; protected offline validation is still required."
        : "FAIL: the redacted physical-device record contains failed checks.");
    } catch (error) {
      // If the native bridge was reached, persist a bounded failure document so
      // the protected runner emits a machine-readable failed verdict. Debug,
      // simulator, or malformed-pin builds are rejected by the native sink.
      try {
        const sink = evidenceSink();
        const runID = await sink.runID();
        const pins = await physicalPins();
        const requiredTests = rawEvidenceTests().map((identifier) =>
          tests.find((test) => test.id === identifier) ?? booleanTest(identifier, false)
        );
        await sink.write(JSON.stringify({
          schema_version: "latchway.react-native-device-run.v2",
          platform: Platform.OS === "ios"
            ? "react_native_ios_app_attest"
            : "react_native_android_play_integrity",
          run: { id: runID, mode: "release", started_at: startedAt, completed_at: new Date().toISOString() },
          gateway_version: diagnostics?.server.version ?? "unknown",
          native: {
            provider: diagnostics?.attestation.provider ?? "unverified",
            trust_level: diagnostics?.attestation.trustLevel ?? "none",
            key_storage: diagnostics?.keyStorage ?? "unknown",
            native_sdk_version: diagnostics?.nativeSDKVersion ?? configured("LATCHWAY_NATIVE_SDK_VERSION"),
            native_evidence_sha256: pins.native_evidence_sha256,
            session_state: diagnostics?.session.state ?? "unknown",
            new_architecture: true,
          },
          pins,
          tests: requiredTests,
          redaction: redactionDeclaration(),
        }));
      } catch {
        // Refusal to persist from a simulator/debug/malformed build is expected.
      }
      setStatus(safeError(error));
    } finally {
      if (physicalConformanceEnabled() && !physicalCleanupComplete) {
        // Retry terminal cleanup best-effort after a failed run, preserving the
        // identity-dependent Latchway-revoke-before-Firebase-sign-out order.
        if (measuredClient !== undefined) {
          try { await measuredClient.revokeCurrentInstallation(); } catch { /* failure record is already terminal */ }
        }
        try { await firebaseAuth().signOut(); } catch { /* protected wipe remains authoritative */ }
        physicalIdentityBootstrap = undefined;
      }
      setBusy(false);
    }
  };

  useEffect(() => {
    if (configuredOptional("LATCHWAY_CONFORMANCE_AUTORUN") === "true" && !evidenceStarted.current) {
      evidenceStarted.current = true;
      void runPhysicalEvidence();
    }
  }, [client]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text accessibilityRole="header" style={styles.title}>Latchway native trust</Text>
        <Text style={styles.subtitle}>Firebase identity · native attestation · device-bound DPoP</Text>
        <Text style={styles.label}>Request input</Text>
        <TextInput
          accessibilityLabel="Request input"
          multiline
          onChangeText={setInput}
          style={styles.input}
          value={input}
        />
        <View style={styles.actions}>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void send(); }} style={styles.primary}>
            <Text style={styles.primaryText}>Send through Latchway</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void inspect(); }} style={styles.secondary}>
            <Text style={styles.secondaryText}>Quota & diagnostics</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void runPhysicalEvidence(); }} style={styles.secondary}>
            <Text style={styles.secondaryText}>Run physical release evidence</Text>
          </Pressable>
        </View>
        {busy ? <ActivityIndicator accessibilityLabel="Latchway operation in progress" /> : null}
        <Text accessibilityLiveRegion="polite" style={styles.status}>{status}</Text>
        {output.length > 0 ? <Text selectable style={styles.output}>{output}</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function required(name: keyof typeof Config): string {
  const value = Config[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${String(name)} must be configured natively.`);
  return value;
}

interface EvidenceSink {
  consumeIdentityGrant(
    applicationID: string,
    packageOrBundleIdentifier: string,
    identityProvider: "firebase",
  ): Promise<string>;
  javascriptBundleSHA256(): Promise<string>;
  runID(): Promise<string>;
  write(encoded: string): Promise<void>;
}

interface EvidenceTest {
  id: string;
  status: "passed" | "failed";
  duration_ms: number;
  http_status?: number;
  error_code?: string;
  request_id?: string;
  mapped_error_type?: "react_native_latchway_error";
}

interface SafeHTTPResult {
  status: number;
  byteCount: number;
  problemCode?: string;
  requestID?: string;
}

function evidenceSink(): EvidenceSink {
  const value = NativeModules.LatchwayEvidence as EvidenceSink | undefined;
  if (value === undefined || typeof value.consumeIdentityGrant !== "function" ||
      typeof value.javascriptBundleSHA256 !== "function" ||
      typeof value.runID !== "function" || typeof value.write !== "function") {
    throw new Error("The physical-evidence native sink is unavailable.");
  }
  return value;
}

function physicalConformanceEnabled(): boolean {
  return configuredOptional("LATCHWAY_CONFORMANCE_AUTORUN") === "true";
}

async function physicalIdentityToken(): Promise<string> {
  await ensureFirebaseApp();
  let user = firebaseAuth().currentUser;
  if (user === null) {
    const bootstrap = physicalIdentityBootstrap ?? bootstrapPhysicalIdentity();
    physicalIdentityBootstrap = bootstrap;
    try {
      await bootstrap;
    } finally {
      if (physicalIdentityBootstrap === bootstrap) physicalIdentityBootstrap = undefined;
    }
    user = firebaseAuth().currentUser;
  }
  if (user === null) throw new Error("The protected one-use identity grant did not establish Firebase identity.");
  return user.getIdToken();
}

async function bootstrapPhysicalIdentity(): Promise<void> {
  // `grant` exists only in this stack frame. The example-native handoff clears
  // its reusable slot before resolving and refuses a second read. Platform app
  // uninstall/data wipe remains the authoritative cleanup boundary.
  const grant = await evidenceSink().consumeIdentityGrant(
    deployment.applicationID,
    deployment.packageOrBundleIdentifier,
    "firebase",
  );
  try {
    await firebaseAuth().signInWithCustomToken(grant);
  } catch {
    // Do not pass a provider error through the UI/evidence path: a third-party
    // diagnostic is not trusted to avoid reflecting credential material.
    throw new Error("Protected one-use Firebase identity bootstrap failed.");
  }
}

async function ensureFirebaseApp(): Promise<void> {
  if (firebaseApp.apps.length > 0) return;
  const initialization = firebaseInitialization ?? initializePhysicalFirebase();
  firebaseInitialization = initialization;
  try {
    await initialization;
  } finally {
    if (firebaseInitialization === initialization) firebaseInitialization = undefined;
  }
}

async function initializePhysicalFirebase(): Promise<void> {
  if (!physicalConformanceEnabled()) {
    throw new Error("Configure the host's default Firebase application before signing in.");
  }
  await firebaseApp.initializeApp({
    apiKey: configured("LATCHWAY_FIREBASE_API_KEY"),
    appId: configured("LATCHWAY_FIREBASE_APP_ID"),
    projectId: configured("LATCHWAY_FIREBASE_PROJECT_ID"),
  });
}

function configured(name: string): string {
  const value = configuredOptional(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} must be embedded in the Release candidate.`);
  return value;
}

function configuredOptional(name: string): string | undefined {
  return (Config as Record<string, string | undefined>)[name];
}

function configuredKeychainAccessGroups(name: string): string[] {
  const value = configuredOptional(name);
  if (value === undefined || value.length === 0) return [];
  const groups = value.split(",");
  if (groups.some((group) => group.length === 0 || group.trim() !== group)) {
    throw new Error(`${name} must be a comma-separated list without whitespace.`);
  }
  return groups;
}

async function physicalPins(): Promise<Record<string, string> & { native_evidence_sha256: string }> {
  const common = {
    source_commit: configured("LATCHWAY_SOURCE_COMMIT"),
    core_commit: configured("LATCHWAY_CORE_COMMIT"),
    contract_bundle_sha256: configured("LATCHWAY_CONTRACT_BUNDLE_SHA256"),
    gateway_image_digest: configured("LATCHWAY_GATEWAY_IMAGE_DIGEST"),
    gateway_configuration_sha256: configured("LATCHWAY_GATEWAY_CONFIGURATION_SHA256"),
    gateway_origin: configured("LATCHWAY_GATEWAY_ORIGIN"),
    gateway_environment: deployment.environment,
    gateway_deployment_key_id: configured("LATCHWAY_GATEWAY_DEPLOYMENT_KEY_ID"),
    gateway_deployment_statement_sha256: configured("LATCHWAY_GATEWAY_DEPLOYMENT_STATEMENT_SHA256"),
    gateway_deployment_public_key_sha256: configured("LATCHWAY_GATEWAY_DEPLOYMENT_PUBLIC_KEY_SHA256"),
    error_mapping_feature: deployment.errorMappingFeature,
    native_evidence_sha256: configured("LATCHWAY_NATIVE_EVIDENCE_SHA256"),
    distribution: configured("LATCHWAY_DISTRIBUTION"),
    signing_certificate_sha256: configured("LATCHWAY_SIGNING_CERTIFICATE_SHA256"),
  };
  if (common.gateway_origin !== deployment.baseURL) {
    throw new Error("LATCHWAY_BASE_URL must exactly match the signed gateway origin.");
  }
  return Platform.OS === "ios" ? {
    ...common,
    // The JavaScript bundle cannot contain its own SHA-256. The collector
    // verifies the signed app first and injects that non-secret digest through
    // the example-native launch boundary.
    javascript_bundle_sha256: await evidenceSink().javascriptBundleSHA256(),
    team_id: configured("LATCHWAY_IOS_TEAM_ID"),
    app_attest_environment: configured("LATCHWAY_APP_ATTEST_ENVIRONMENT"),
  } : {
    ...common,
    play_track: configured("LATCHWAY_PLAY_TRACK"),
    cloud_project_number: configured("LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER"),
    require_licensed: configured("LATCHWAY_REQUIRE_LICENSED"),
  };
}

function rawEvidenceTests(): string[] {
  return [
    "react_native_bridge",
    Platform.OS === "ios" ? "app_attest_session" : "play_integrity_session",
    Platform.OS === "ios" ? "secure_enclave_key" : "hardware_backed_key",
    "dpop_authorized_request",
    "canonical_error_mapping",
    "streamed_request",
    "quota",
  ];
}

function booleanTest(id: string, passed: boolean): EvidenceTest {
  return { id, status: passed ? "passed" : "failed", duration_ms: 0 };
}

function httpTest(id: string, response: SafeHTTPResult, passed: boolean): EvidenceTest {
  return {
    id,
    status: passed ? "passed" : "failed",
    duration_ms: 0,
    http_status: response.status,
    ...(response.problemCode === undefined ? {} : { error_code: response.problemCode }),
    ...(response.requestID === undefined ? {} : { request_id: response.requestID }),
  };
}

function redactionDeclaration(): Record<string, false> {
  return {
    identity_token_recorded: false,
    session_token_recorded: false,
    refresh_token_recorded: false,
    dpop_proof_recorded: false,
    attestation_evidence_recorded: false,
    private_key_recorded: false,
    provider_credential_recorded: false,
  };
}

async function inspectBounded(response: Response, maximumBytes: number): Promise<SafeHTTPResult> {
  const body = await readBounded(response, maximumBytes);
  const requestID = safeRequestID(response.headers.get("X-Latchway-Request-ID"));
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  let problemCode: string | undefined;
  if (contentType === "application/problem+json") {
    try {
      const value = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
      const code = typeof value.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value.code)
        ? value.code
        : undefined;
      if (code !== undefined && value.status === response.status && value.request_id === requestID &&
          value.type === `https://latchway.dev/problems/${code}` &&
          typeof value.title === "string" && value.title.length > 0 &&
          typeof value.detail === "string" && value.detail.length > 0 &&
          typeof value.retryable === "boolean") {
        problemCode = code;
      }
    } catch {
      // A malformed problem remains untrusted and cannot satisfy a negative test.
    }
  }
  return {
    status: response.status,
    byteCount: body.byteLength,
    ...(requestID === undefined ? {} : { requestID }),
    ...(problemCode === undefined ? {} : { problemCode }),
  };
}

async function readBounded(response: Response, maximumBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("Physical evidence response limit exceeded");
        throw new Error("Gateway response exceeded the bounded evidence limit.");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function consumeStreamBytes(response: Response, maximumBytes: number): Promise<number> {
  if (response.body === null) throw new Error("Gateway did not return a response stream.");
  const reader = response.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("Physical evidence stream limit exceeded");
        throw new Error("Stream exceeded the bounded evidence limit.");
      }
    }
  } finally {
    reader.releaseLock();
  }
  return size;
}

function safeRequestID(value: string | null): string | undefined {
  return value !== null && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value) ? value : undefined;
}

function optionalRequestID(value: string | null): { requestID?: string } {
  const requestID = safeRequestID(value);
  return requestID === undefined ? {} : { requestID };
}

function safeError(error: unknown): string {
  if (error instanceof LatchwayError) {
    const request = error.requestID === undefined ? "" : ` · request ${error.requestID}`;
    return `${error.code}${request}: ${error.message}`;
  }
  return error instanceof Error ? error.message : "The operation failed.";
}

async function consumeStream(response: Response, update: (value: string) => void): Promise<void> {
  if (response.body === null) throw new Error("Gateway did not return a response stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1_048_576) {
        await reader.cancel("Example display limit reached");
        throw new Error("Stream exceeded the example's 1 MiB display limit.");
      }
      output += decoder.decode(chunk.value, { stream: true });
      update(output);
    }
    output += decoder.decode();
    update(output);
  } finally {
    reader.releaseLock();
  }
}

const styles = StyleSheet.create({
  safeArea: { backgroundColor: "#f5f7f4", flex: 1 },
  content: { gap: 14, padding: 24 },
  title: { color: "#143b2b", fontSize: 28, fontWeight: "700" },
  subtitle: { color: "#456257", fontSize: 15 },
  label: { color: "#143b2b", fontSize: 14, fontWeight: "600", marginTop: 10 },
  input: { backgroundColor: "white", borderColor: "#b7c8bf", borderRadius: 12, borderWidth: 1, minHeight: 110, padding: 14, textAlignVertical: "top" },
  actions: { gap: 10 },
  primary: { alignItems: "center", backgroundColor: "#16613f", borderRadius: 10, padding: 14 },
  primaryText: { color: "white", fontWeight: "700" },
  secondary: { alignItems: "center", borderColor: "#16613f", borderRadius: 10, borderWidth: 1, padding: 14 },
  secondaryText: { color: "#16613f", fontWeight: "700" },
  status: { color: "#456257", fontSize: 13 },
  output: { backgroundColor: "#e8eee9", borderRadius: 10, color: "#17231d", fontFamily: "Courier", padding: 14 },
});

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
  type ReactNativeIOSComponent,
} from "@latchway/react-native";
import { freshClientAfterRevocation } from "./evidence-client";
import {
  createFrameworkConsumers,
  runFrameworkConsumerSmoke,
  type FrameworkFeatureBindings,
} from "./framework-consumers";

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
  appIntentComponentDefinitionID: Platform.OS === "ios" && __DEV__
    ? configuredOptional("LATCHWAY_APPINTENT_COMPONENT_DEFINITION_ID")
    : undefined,
};

let physicalIdentityBootstrap: Promise<void> | undefined;
let developmentIdentityBootstrap: Promise<void> | undefined;
let developmentRunPhase: "initial" | "resume" | "abort" | "abort_sign_out" | undefined;
let firebaseInitialization: Promise<void> | undefined;

function makeClient(): LatchwayClient {
  return createLatchwayClient({
    baseURL: deployment.baseURL,
    applicationID: deployment.applicationID,
    environment: deployment.environment,
    identityProvider: "firebase",
    getIdentityToken: physicalConformanceEnabled()
      ? physicalIdentityToken
      : developmentDeviceBootstrapEnabled()
        ? developmentIdentityToken
        : ordinaryIdentityToken,
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
  const developmentVerificationStarted = useRef(false);

  const send = async (): Promise<void> => {
    setBusy(true);
    setOutput("");
    try {
      const response = await client.fetch("/v1/responses", {
        method: "POST",
        latchwayFeature: deployment.feature,
        headers: {
          Accept: "text/event-stream",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: deployment.model,
          input,
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

  const runFrameworks = async (): Promise<void> => {
    setBusy(true);
    setOutput("");
    try {
      const consumers = createFrameworkConsumers(client, frameworkFeatureBindings());
      const result = await runFrameworkConsumerSmoke(consumers, input);
      setOutput(JSON.stringify(result, null, 2));
      setStatus("OpenAI, Vercel AI, LangChain, and Anthropic completed through native fetch");
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
    let replacementFailureDiagnostics: Awaited<ReturnType<typeof client.diagnostics>> | undefined;
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
      measuredClient = await freshClientAfterRevocation(client, makeClient, async (replacement) => {
        replacementFailureDiagnostics = await replacement.diagnostics();
      });
      setClient(measuredClient);

      const firstResponse = await measuredClient.fetch("/v1/responses", {
        method: "POST",
        latchwayFeature: deployment.feature,
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: deployment.model,
          input: "Return the word conformance.",
          stream: false,
        }),
      });
      const first = await inspectBounded(firstResponse, 65_536);
      tests.push(httpTest("dpop_authorized_request", first, first.status >= 200 && first.status < 300));

      if (Platform.OS === "ios") {
        const registrationDiagnostics = await measuredClient.diagnostics();
        const registeredInstallationID = registrationDiagnostics.installation.id;
        const registrationReady = registeredInstallationID !== undefined &&
          registrationDiagnostics.attestation.provider === "app_attest" &&
          registrationDiagnostics.attestation.lastOperation === "attestation" &&
          registrationDiagnostics.session.state === "active";
        if (!registrationReady || deployment.rootKeychainAccessGroup === undefined) {
          tests.push(booleanTest("app_attest_assertion", false));
          throw new Error("The physical App Attest registration was not ready for assertion reuse.");
        }

        // Release the native context, retire only its persisted session, then
        // re-establish with the same Secure Enclave installation key and the
        // accepted App Attest key marker. The example-native method is a
        // physical Release-only, one-use diagnostic and cannot reset either
        // key. No identifier or attestation material is written to evidence.
        await measuredClient.dispose();
        await sink.retireSessionForAssertionReuse(
          deployment.applicationID,
          deployment.environment,
          deployment.rootKeychainAccessGroup,
          deployment.legacySharedKeychainAccessGroups,
        );
        measuredClient = makeClient();
        await measuredClient.ready;
        await measuredClient.refresh();
        setClient(measuredClient);

        const assertionDiagnostics = await measuredClient.diagnostics();
        const assertionPassed = assertionDiagnostics.attestation.provider === "app_attest" &&
          assertionDiagnostics.attestation.lastOperation === "assertion" &&
          assertionDiagnostics.attestation.trustLevel === "app_verified" &&
          assertionDiagnostics.session.state === "active" &&
          assertionDiagnostics.installation.id === registeredInstallationID &&
          assertionDiagnostics.keyStorage === registrationDiagnostics.keyStorage;
        tests.push(booleanTest("app_attest_assertion", assertionPassed));
        if (!assertionPassed) {
          throw new Error("The physical App Attest assertion did not reuse the registered installation.");
        }
      }

      // The public bridge deliberately has no authorization-envelope escape
      // hatch. Replay, proof mutation, credential rotation, protocol mutation,
      // and post-revocation enforcement are imported by the protected
      // finalizer from the exact hash-pinned native evidence report. JavaScript
      // proves only behavior that crosses the opaque production bridge.

      // This protected feature is intentionally outside the root component's
      // grant. Authorization must reject it before feature lookup, including
      // when the name is absent from gateway configuration.
      try {
        await measuredClient.quota(deployment.errorMappingFeature);
        tests.push({ id: "canonical_error_mapping", status: "failed", duration_ms: 0 });
      } catch (error) {
        const mapped = error instanceof LatchwayError;
        const mappedRequestID = mapped ? safeRequestID(error.requestID ?? null) : undefined;
        tests.push({
          id: "canonical_error_mapping",
          status: mapped && error.code === "component_feature_not_granted" && error.status === 403 &&
            mappedRequestID !== undefined ? "passed" : "failed",
          duration_ms: 0,
          ...(mapped && typeof error.status === "number" ? { http_status: error.status } : {}),
          ...(mapped ? { error_code: error.code, mapped_error_type: "react_native_latchway_error" } : {}),
          ...(mappedRequestID === undefined ? {} : { request_id: mappedRequestID }),
        });
      }

      const stream = await measuredClient.fetch("/v1/responses", {
        method: "POST",
        latchwayFeature: deployment.feature,
        headers: { Accept: "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({
          model: deployment.model,
          input: "Return the word conformance.",
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
      try {
        // After the fresh-install transition, the measured replacement owns
        // the attestation attempt and its safe failure phase. The original
        // client is already revoked and disposed at that point.
        diagnostics = replacementFailureDiagnostics ?? await (measuredClient ?? client).diagnostics();
        setOutput(JSON.stringify(physicalDiagnosticsSummary(diagnostics), null, 2));
      } catch {
        // A diagnostic read is best-effort and never replaces the original
        // failure. The allowlisted summary below omits installation, request,
        // provider-evidence, and identity material.
      }
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
    if (developmentDeviceBootstrapEnabled() && !developmentVerificationStarted.current) {
      developmentVerificationStarted.current = true;
      void runDevelopmentVerification(client, setStatus, setOutput, setBusy);
    }
  }, [client]);

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
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { void runFrameworks(); }} style={styles.secondary}>
            <Text style={styles.secondaryText}>Run framework consumers</Text>
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
  retireSessionForAssertionReuse(
    applicationID: string,
    environment: string,
    rootKeychainAccessGroup: string,
    legacySharedKeychainAccessGroups: string[],
  ): Promise<void>;
  runID(): Promise<string>;
  write(encoded: string): Promise<void>;
}

interface DevelopmentIdentitySink {
  consumeDevelopmentIdentityGrant(
    applicationID: string,
    packageOrBundleIdentifier: string,
    identityProvider: "firebase",
  ): Promise<string>;
  developmentVerificationPhase(): Promise<"initial" | "resume" | "abort" | "abort_sign_out">;
  clearDevelopmentAppIntentArtifacts(accessGroup: string): Promise<void>;
  markDevelopmentAppIntentWaiting(accessGroup: string): Promise<void>;
  consumeDevelopmentAppIntentReceipt(accessGroup: string): Promise<void>;
  completeDevelopmentVerification(): Promise<void>;
  completeDevelopmentAbort(): Promise<void>;
  failDevelopmentVerification(stage: DevelopmentVerificationStage, code: string): Promise<void>;
}

type DevelopmentVerificationStage =
  | "firebase_configuration"
  | "firebase_custom_token"
  | "native_session_establishment"
  | "gateway_responses"
  | "diagnostics"
  | "quota"
  | "component_prepare"
  | "app_intent_wait"
  | "app_intent_receipt"
  | "family_revoke"
  | "firebase_sign_out"
  | "success_marker";

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
  diagnosticProblemCode?: string;
  problemCode?: string;
  requestID?: string;
}

function evidenceSink(): EvidenceSink {
  const value = NativeModules.LatchwayEvidence as EvidenceSink | undefined;
  if (value === undefined || typeof value.consumeIdentityGrant !== "function" ||
      typeof value.javascriptBundleSHA256 !== "function" ||
      (Platform.OS === "ios" && typeof value.retireSessionForAssertionReuse !== "function") ||
      typeof value.runID !== "function" || typeof value.write !== "function") {
    throw new Error("The physical-evidence native sink is unavailable.");
  }
  return value;
}

function developmentIdentitySink(): DevelopmentIdentitySink {
  const value = NativeModules.LatchwayDevelopmentBootstrap as DevelopmentIdentitySink | undefined;
  if (value === undefined || typeof value.consumeDevelopmentIdentityGrant !== "function" ||
      typeof value.developmentVerificationPhase !== "function" ||
      typeof value.clearDevelopmentAppIntentArtifacts !== "function" ||
      typeof value.markDevelopmentAppIntentWaiting !== "function" ||
      typeof value.consumeDevelopmentAppIntentReceipt !== "function" ||
      typeof value.completeDevelopmentVerification !== "function" ||
      typeof value.completeDevelopmentAbort !== "function" ||
      typeof value.failDevelopmentVerification !== "function") {
    throw new Error("The Debug-only Firebase identity bridge is unavailable.");
  }
  return value;
}

function physicalConformanceEnabled(): boolean {
  return configuredOptional("LATCHWAY_CONFORMANCE_AUTORUN") === "true";
}

function developmentDeviceBootstrapEnabled(): boolean {
  return __DEV__ && Platform.OS === "ios" &&
    configuredOptional("LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP") === "true";
}

async function ordinaryIdentityToken(): Promise<string> {
  await ensureFirebaseApp();
  const user = firebaseAuth().currentUser;
  if (user === null) throw new Error("Sign in with Firebase before calling Latchway.");
  return user.getIdToken();
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

async function developmentIdentityToken(): Promise<string> {
  await ensureFirebaseApp();
  if (developmentRunPhase === "resume" || developmentRunPhase === "abort" ||
      developmentRunPhase === "abort_sign_out") {
    const resumedUser = firebaseAuth().currentUser;
    if (resumedUser === null) throw new Error("The Debug cleanup identity is unavailable.");
    return resumedUser.getIdToken();
  }
  const bootstrap = developmentIdentityBootstrap ?? bootstrapDevelopmentIdentity();
  developmentIdentityBootstrap = bootstrap;
  try {
    await bootstrap;
  } catch (error) {
    if (developmentIdentityBootstrap === bootstrap) developmentIdentityBootstrap = undefined;
    throw error;
  }
  const user = firebaseAuth().currentUser;
  if (user === null) throw new Error("The Debug-only Firebase identity bootstrap did not establish a user.");
  return user.getIdToken();
}

async function bootstrapDevelopmentIdentity(): Promise<void> {
  try {
    // Take and validate the terminal native slot before changing an existing
    // Firebase session. A reload after a completed one-use exchange therefore
    // cannot sign out a valid user merely because the native slot is exhausted.
    const grant = await developmentIdentitySink().consumeDevelopmentIdentityGrant(
      deployment.applicationID,
      deployment.packageOrBundleIdentifier,
      "firebase",
    );
    if (firebaseAuth().currentUser !== null) await firebaseAuth().signOut();
    await firebaseAuth().signInWithCustomToken(grant);
  } catch (error) {
    // Firebase messages can contain provider-controlled diagnostic text. Keep
    // only the documented, normalized error code for the local exact-run
    // receipt and UI; the credential and provider message never cross this
    // boundary.
    const failure = new Error("Debug-only one-use Firebase identity bootstrap failed.") as Error & { code: string };
    failure.code = safeDevelopmentFailureCode(error);
    throw failure;
  }
}

async function runDevelopmentVerification(
  current: LatchwayClient,
  setStatus: (value: string) => void,
  setOutput: (value: string) => void,
  setBusy: (value: boolean) => void,
): Promise<void> {
  let sink: DevelopmentIdentitySink | undefined;
  let component: ReactNativeIOSComponent | undefined;
  let measured: LatchwayClient | undefined;
  let developmentIdentityEstablished = false;
  let terminalCleanupComplete = false;
  let waitingForAppIntent = false;
  let familyCleanupRequired = false;
  let terminalFailure: { stage: DevelopmentVerificationStage; code: string } | undefined;
  let failureStage: DevelopmentVerificationStage = "firebase_configuration";
  setBusy(true);
  setOutput("");
  setStatus("Running Debug physical-device verification");
  try {
    sink = developmentIdentitySink();
    component = developmentAppIntentComponent();
    const phase = await sink.developmentVerificationPhase();
    developmentRunPhase = phase;
    if (phase === "abort" || phase === "abort_sign_out") {
      failureStage = "family_revoke";
      await sink.clearDevelopmentAppIntentArtifacts(component.keychainAccessGroup);
      await ensureFirebaseApp();
      if (phase === "abort" && firebaseAuth().currentUser === null) {
        throw new Error("The Debug abort cleanup identity is unavailable.");
      }
      developmentIdentityEstablished = firebaseAuth().currentUser !== null;
      if (phase === "abort") {
        await current.ready;
        await current.revokeCurrentInstallationFamily([component]);
      }
      // `abort_sign_out` is admitted only after descriptor-bound family
      // retirement completed. It does not create a new root merely to revoke
      // it again and retries only the remaining Firebase cleanup below.
      failureStage = "firebase_sign_out";
      await current.dispose();
      if (firebaseAuth().currentUser !== null) await firebaseAuth().signOut();
      if (firebaseAuth().currentUser !== null) {
        throw new Error("Debug abort Firebase cleanup did not complete.");
      }
      developmentIdentityBootstrap = undefined;
      terminalCleanupComplete = true;
      await sink.completeDevelopmentAbort();
      setStatus("Debug App Intent timeout cleanup completed");
      return;
    }
    if (phase === "resume") {
      failureStage = "app_intent_receipt";
      await ensureFirebaseApp();
      if (firebaseAuth().currentUser === null) {
        throw new Error("The Debug cleanup identity is unavailable.");
      }
      developmentIdentityEstablished = true;
      await sink.consumeDevelopmentAppIntentReceipt(component.keychainAccessGroup);
      failureStage = "family_revoke";
      await current.ready;
      await current.revokeCurrentInstallationFamily([component]);
      failureStage = "firebase_sign_out";
      await current.dispose();
      await firebaseAuth().signOut();
      if (firebaseAuth().currentUser !== null) {
        throw new Error("Debug Firebase identity cleanup did not complete.");
      }
      developmentIdentityBootstrap = undefined;
      developmentRunPhase = undefined;
      terminalCleanupComplete = true;
      failureStage = "success_marker";
      await sink.completeDevelopmentVerification();
      setOutput(JSON.stringify({
        app_intent_delegated_session: true,
        app_intent_delegated_request: true,
        installation_family_revoked: true,
        firebase_signed_out: true,
      }, null, 2));
      setStatus("Debug delegated App Intent verification completed");
      return;
    }

    await sink.clearDevelopmentAppIntentArtifacts(component.keychainAccessGroup);
    // Establish the exact fresh Firebase user first. The following explicit
    // family revocation also retires any prior descriptor-bound component
    // material before the replacement performs App Attest establishment.
    await ensureFirebaseApp();
    failureStage = "firebase_custom_token";
    await developmentIdentityToken();
    if (firebaseAuth().currentUser === null) {
      throw new Error("Debug Firebase identity was not established.");
    }
    developmentIdentityEstablished = true;
    // From this point until the old family is retired, Firebase identity must
    // survive any failure so the runner can relaunch this exact run in its
    // bounded abort phase. A unique one-use Firebase user cannot be recreated.
    familyCleanupRequired = true;
    failureStage = "family_revoke";
    await current.ready;
    await current.revokeCurrentInstallationFamily([component]);
    familyCleanupRequired = false;
    failureStage = "native_session_establishment";
    await current.dispose();
    measured = makeClient();
    familyCleanupRequired = true;
    await measured.ready;

    failureStage = "gateway_responses";
    const response = await measured.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: deployment.feature,
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: deployment.model,
        input: "Return the word verified.",
        stream: false,
      }),
    });
    const result = await inspectBounded(response, 65_536);
    if (!response.ok || result.byteCount === 0) {
      const failure = new Error("Debug gateway Responses verification failed.") as Error & { code: string };
      failure.code = developmentHTTPFailureCode(result);
      throw failure;
    }

    failureStage = "diagnostics";
    const diagnostics = await measured.diagnostics();
    if (diagnostics.platform !== "react_native_ios" ||
        diagnostics.attestation.provider !== "app_attest" ||
        diagnostics.attestation.trustLevel !== "app_verified" ||
        diagnostics.session.state !== "active") {
      throw new Error("Debug App Attest diagnostics did not reach app_verified.");
    }
    failureStage = "quota";
    const quota = await measured.quota(deployment.feature);
    if (quota.feature !== deployment.feature) {
      throw new Error("Debug quota verification returned the wrong feature.");
    }

    failureStage = "component_prepare";
    const prepared = await measured.prepareComponents([component]);
    const componentDiagnostics = prepared[0];
    if (prepared.length !== 1 || componentDiagnostics === undefined ||
        componentDiagnostics.definitionID !== component.definitionID ||
        componentDiagnostics.keychainAccessGroup !== component.keychainAccessGroup ||
        !componentDiagnostics.keyAvailable || componentDiagnostics.keyStorage !== "secure_enclave" ||
        !componentDiagnostics.grantAvailable ||
        componentDiagnostics.trustSource !== "delegated_from_attested_root" ||
        componentDiagnostics.containingAppActionRequired) {
      throw new Error("Debug delegated App Intent provisioning did not become ready.");
    }

    // Leave the prepared family intact for the separately launched extension.
    // The marker is the last fallible operation in this branch: once it is
    // visible, every exit belongs to the runner's exact-run abort boundary.
    // The one-use launch grant was already destroyed in both processes.
    failureStage = "app_intent_wait";
    setOutput(JSON.stringify({
      platform: diagnostics.platform,
      provider: diagnostics.attestation.provider,
      trust_level: diagnostics.attestation.trustLevel,
      responses_status: result.status,
      quota_feature: quota.feature,
      component_prepared: true,
      waiting_for_app_intent: true,
    }, null, 2));
    setStatus("Waiting for the Run Latchway Proof App Intent");
    await sink.markDevelopmentAppIntentWaiting(component.keychainAccessGroup);
    waitingForAppIntent = true;
    familyCleanupRequired = false;
    developmentIdentityBootstrap = undefined;
    developmentRunPhase = undefined;
  } catch (error) {
    const failureCode = safeDevelopmentFailureCode(error);
    terminalFailure = { stage: failureStage, code: failureCode };
    setOutput(JSON.stringify({ failure_stage: failureStage, failure_code: failureCode }, null, 2));
    setStatus("Debug physical-device verification failed.");
  } finally {
    if (!terminalCleanupComplete && !waitingForAppIntent) {
      const exactRunCleanupPending = developmentRunPhase === "resume" ||
        developmentRunPhase === "abort" || developmentRunPhase === "abort_sign_out";
      if (!exactRunCleanupPending) {
        // Do not immediately retry the operation that just failed: retain its
        // exact Firebase identity and publish an abort-admissible family_revoke
        // marker. For a later-stage failure, attempt local compensation once;
        // only a verified retirement permits sign-out.
        if (familyCleanupRequired && terminalFailure?.stage !== "family_revoke" &&
            measured !== undefined && component !== undefined) {
          try {
            await measured.revokeCurrentInstallationFamily([component]);
            familyCleanupRequired = false;
          } catch (cleanupError) {
            terminalFailure = {
              stage: "family_revoke",
              code: safeDevelopmentFailureCode(cleanupError),
            };
          }
        }
        if (measured !== undefined) {
          try { await measured.dispose(); } catch { /* native state remains retryable */ }
        }
        if (developmentIdentityEstablished && !familyCleanupRequired) {
          try { await firebaseAuth().signOut(); } catch { /* verify persisted state below */ }
          if (firebaseAuth().currentUser === null) {
            developmentIdentityBootstrap = undefined;
          } else {
            terminalFailure = { stage: "firebase_sign_out", code: "verification_failed" };
          }
        }
        if (sink !== undefined && component !== undefined) {
          try {
            await sink.clearDevelopmentAppIntentArtifacts(component.keychainAccessGroup);
          } catch { /* no marker is emitted */ }
        }
      }
      // Resume/abort failures retain their exact marker and cleanup state for
      // the runner's one centralized bounded abort launch. Before the waiting
      // boundary, a missing native slot still leaves prior Firebase state
      // untouched so a Metro reload cannot destroy valid authentication.
    }
    if (terminalFailure !== undefined && sink !== undefined) {
      try {
        await sink.failDevelopmentVerification(terminalFailure.stage, terminalFailure.code);
      } catch {
        // A missing/invalid/consumed native slot cannot produce an exact-run
        // marker. Any cleanup authority retained above remains persisted.
      }
    }
    if (!waitingForAppIntent) developmentRunPhase = undefined;
    setBusy(false);
  }
}

function developmentAppIntentComponent(): ReactNativeIOSComponent {
  const definitionID = deployment.appIntentComponentDefinitionID;
  const keychainAccessGroup = deployment.legacySharedKeychainAccessGroups[0];
  if (definitionID === undefined || keychainAccessGroup === undefined ||
      deployment.legacySharedKeychainAccessGroups.length !== 1) {
    throw new Error("The Debug App Intent component descriptor is unavailable.");
  }
  return {
    definitionID,
    kind: "app_intent_extension",
    keychainAccessGroup,
    requestedFeatures: [deployment.feature],
  };
}

function safeDevelopmentFailureCode(error: unknown): string {
  const candidate = error instanceof LatchwayError
    ? error.code
    : typeof error === "object" && error !== null && "code" in error &&
        typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "verification_failed";
  const normalized = candidate.toLowerCase().replace(/[^a-z0-9_]+/gu, "_").replace(/^_+|_+$/gu, "");
  return /^[a-z][a-z0-9_]{1,99}$/u.test(normalized) ? normalized : "verification_failed";
}

function developmentHTTPFailureCode(result: SafeHTTPResult): string {
  const code = result.problemCode ?? result.diagnosticProblemCode;
  if (code !== undefined && /^[a-z][a-z0-9_]{1,99}$/u.test(code)) {
    return code;
  }
  return Number.isInteger(result.status) && result.status >= 100 && result.status <= 599
    ? `http_${result.status}`
    : "verification_failed";
}

async function ensureFirebaseApp(): Promise<void> {
  if (firebaseApp.apps.length > 0) return;
  if (developmentDeviceBootstrapEnabled()) {
    throw new Error("The Debug-only Firebase plist did not initialize the default application.");
  }
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
    databaseURL: configured("LATCHWAY_FIREBASE_DATABASE_URL"),
    messagingSenderId: configured("LATCHWAY_FIREBASE_MESSAGING_SENDER_ID"),
    projectId: configured("LATCHWAY_FIREBASE_PROJECT_ID"),
    storageBucket: configured("LATCHWAY_FIREBASE_STORAGE_BUCKET"),
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

function frameworkFeatureBindings(): FrameworkFeatureBindings {
  return {
    responses: deployment.feature,
    chat: configuredFrameworkFeature("LATCHWAY_OPENAI_CHAT_FEATURE"),
    embeddings: configuredFrameworkFeature("LATCHWAY_OPENAI_EMBEDDINGS_FEATURE"),
    anthropic: configuredFrameworkFeature("LATCHWAY_ANTHROPIC_MESSAGES_FEATURE"),
  };
}

function configuredFrameworkFeature(name: string): string {
  const value = configuredOptional(name);
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be configured to run the framework consumers.`);
  }
  return value;
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
    ...(Platform.OS === "ios" ? ["app_attest_assertion"] : []),
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

function physicalDiagnosticsSummary(
  diagnostics: Awaited<ReturnType<LatchwayClient["diagnostics"]>>,
): Record<string, unknown> {
  return {
    platform: diagnostics.platform,
    key_storage: diagnostics.keyStorage,
    attestation: {
      support: diagnostics.attestation.support,
      provider: diagnostics.attestation.provider ?? "unverified",
      trust_level: diagnostics.attestation.trustLevel ?? "none",
      last_operation: diagnostics.attestation.lastOperation ?? "none",
    },
    session: { state: diagnostics.session.state },
    last_error_code: diagnostics.lastErrorCode ?? "none",
  };
}

async function inspectBounded(response: Response, maximumBytes: number): Promise<SafeHTTPResult> {
  const body = await readBounded(response, maximumBytes);
  const requestID = safeRequestID(response.headers.get("X-Latchway-Request-ID"));
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  let diagnosticProblemCode: string | undefined;
  let problemCode: string | undefined;
  if (contentType === "application/problem+json") {
    try {
      const value = JSON.parse(decodeBoundedUTF8(body)) as Record<string, unknown>;
      const code = typeof value.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(value.code)
        ? value.code
        : undefined;
      if (code !== undefined && value.status === response.status &&
          value.type === `https://latchway.dev/problems/${code}` &&
          typeof value.title === "string" && value.title.length > 0 &&
          typeof value.detail === "string" && value.detail.length > 0 &&
          typeof value.retryable === "boolean") {
        // The Debug-only exact-run receipt may retain this bounded canonical
        // code to diagnose a local disposable stack. Physical conformance still
        // requires response/header request-ID correlation before accepting the
        // code as trusted negative-test evidence.
        diagnosticProblemCode = code;
        if (requestID !== undefined && value.request_id === requestID) {
          problemCode = code;
        }
      }
    } catch {
      // A malformed problem remains untrusted and cannot satisfy a negative test.
    }
  }
  return {
    status: response.status,
    byteCount: body.byteLength,
    ...(requestID === undefined ? {} : { requestID }),
    ...(diagnosticProblemCode === undefined ? {} : { diagnosticProblemCode }),
    ...(problemCode === undefined ? {} : { problemCode }),
  };
}

function decodeBoundedUTF8(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index];
    if (first === undefined) {
      throw new Error("Gateway problem response is not valid UTF-8.");
    }
    let codePoint: number;
    let width: number;
    if (first <= 0x7f) {
      codePoint = first;
      width = 1;
    } else if (first >= 0xc2 && first <= 0xdf) {
      codePoint = first & 0x1f;
      width = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      codePoint = first & 0x0f;
      width = 3;
    } else if (first >= 0xf0 && first <= 0xf4) {
      codePoint = first & 0x07;
      width = 4;
    } else {
      throw new Error("Gateway problem response is not valid UTF-8.");
    }
    if (index + width > bytes.length) {
      throw new Error("Gateway problem response is not valid UTF-8.");
    }
    for (let offset = 1; offset < width; offset += 1) {
      const next = bytes[index + offset];
      if (next === undefined) {
        throw new Error("Gateway problem response is not valid UTF-8.");
      }
      if ((next & 0xc0) !== 0x80) {
        throw new Error("Gateway problem response is not valid UTF-8.");
      }
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    const overlong = (width === 2 && codePoint < 0x80) ||
      (width === 3 && codePoint < 0x800) || (width === 4 && codePoint < 0x10000);
    if (overlong || (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint > 0x10ffff) {
      throw new Error("Gateway problem response is not valid UTF-8.");
    }
    output += String.fromCodePoint(codePoint);
    index += width;
  }
  return output;
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

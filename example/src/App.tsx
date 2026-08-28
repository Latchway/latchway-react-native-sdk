import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
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
import { getAuth } from "@react-native-firebase/auth";
import { createLatchwayClient, LatchwayError } from "@latchway/react-native";

const deployment = {
  baseURL: required("LATCHWAY_BASE_URL"),
  applicationID: required("LATCHWAY_APPLICATION_ID"),
  environment: required("LATCHWAY_ENVIRONMENT"),
  feature: required("LATCHWAY_FEATURE"),
  model: required("LATCHWAY_MODEL"),
  googleCloudProjectNumber: Platform.OS === "android"
    ? required("LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER")
    : undefined,
};

export default function App(): React.JSX.Element {
  const [input, setInput] = useState("Plan a focused afternoon.");
  const [output, setOutput] = useState("");
  const [status, setStatus] = useState("Ready");
  const [busy, setBusy] = useState(false);
  const client = useMemo(() => createLatchwayClient({
    baseURL: deployment.baseURL,
    applicationID: deployment.applicationID,
    environment: deployment.environment,
    identityProvider: "firebase",
    getIdentityToken: async () => {
      const user = getAuth().currentUser;
      if (user === null) throw new Error("Sign in with Firebase before calling Latchway.");
      return user.getIdToken();
    },
    ...(deployment.googleCloudProjectNumber === undefined ? {} : {
      android: { playIntegrityCloudProjectNumber: deployment.googleCloudProjectNumber },
    }),
  }), []);

  useEffect(() => () => { void client.dispose(); }, [client]);

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

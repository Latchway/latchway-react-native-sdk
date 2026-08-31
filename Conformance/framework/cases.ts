export type ReactNativeFrameworkID = "react-native-fetch";

export interface FrameworkCaseDescriptor {
  readonly id: FrameworkCaseID;
  readonly title: string;
  readonly framework: ReactNativeFrameworkID;
}

export interface ReactNativeFrameworkCaseDescriptor {
  readonly id: ReactNativeFrameworkCaseID;
  readonly title: string;
  readonly framework: ReactNativeFrameworkID;
}

/**
 * Stable black-box case IDs shared with the JavaScript framework suite.
 * React Native adds no second chat/model abstraction: every case exercises the
 * registry-owned `react-native-fetch` transport through an actual consumer.
 */
export const FRAMEWORK_CASES = [
  frameworkCase("FW-AUTH-001", "binds the feature and exact framework version"),
  frameworkCase("FW-REQ-001", "preserves an OpenAI Responses request and response"),
  frameworkCase("FW-REQ-002", "preserves a Chat Completions request and response"),
  frameworkCase("FW-REQ-003", "preserves an embeddings request and response"),
  frameworkCase("FW-REQ-004", "preserves safe caller headers and request metadata"),
  frameworkCase("FW-REQ-005", "delivers streaming bytes and final usage"),
  frameworkCase("FW-REQ-006", "propagates cancellation to the authenticated request"),
  frameworkCase("FW-BEH-001", "preserves tool definitions"),
  frameworkCase("FW-BEH-002", "preserves and parses structured output"),
  frameworkCase("FW-BEH-003", "maps quota denial with the Latchway request ID"),
  frameworkCase("FW-BEH-004", "preserves provider errors and correlation metadata"),
  frameworkCase("FW-BEH-005", "creates a fresh authenticated dispatch for framework retries"),
  frameworkCase("FW-SEC-001", "strips provider placeholder credentials before dispatch"),
  frameworkCase("FW-SEC-002", "rejects a mismatched origin and undeclared path before session work"),
  frameworkCase("FW-SEC-003", "does not expose credentials in framework errors"),
  frameworkCase("FW-SEC-004", "does not mutate or fall back to global fetch"),
] as const satisfies readonly FrameworkCaseDescriptor[];

/** React Native-specific coverage that must not be attributed to shared cases. */
export const REACT_NATIVE_FRAMEWORK_CASES = [
  reactNativeCase("RN-FW-REFRESH-001", "explicitly refreshes before a framework request"),
  reactNativeCase(
    "RN-FW-ANTHROPIC-001",
    "executes Anthropic Messages through Vercel AI over native fetch",
  ),
  reactNativeCase("RN-FW-OPAQUE-001", "executes a feature-bound opaque route over native fetch"),
  reactNativeCase("RN-FW-CONSUMER-001", "executes every example consumer over one native fetch"),
] as const satisfies readonly ReactNativeFrameworkCaseDescriptor[];

export type FrameworkCaseID =
  | "FW-AUTH-001"
  | "FW-REQ-001"
  | "FW-REQ-002"
  | "FW-REQ-003"
  | "FW-REQ-004"
  | "FW-REQ-005"
  | "FW-REQ-006"
  | "FW-BEH-001"
  | "FW-BEH-002"
  | "FW-BEH-003"
  | "FW-BEH-004"
  | "FW-BEH-005"
  | "FW-SEC-001"
  | "FW-SEC-002"
  | "FW-SEC-003"
  | "FW-SEC-004";

export type ReactNativeFrameworkCaseID =
  | "RN-FW-REFRESH-001"
  | "RN-FW-ANTHROPIC-001"
  | "RN-FW-OPAQUE-001"
  | "RN-FW-CONSUMER-001";

export function assertFrameworkCaseCoverage(observed: ReadonlySet<FrameworkCaseID>): void {
  const expected = new Set(FRAMEWORK_CASES.map(({ id }) => id));
  const missing = [...expected].filter((id) => !observed.has(id));
  const unexpected = [...observed].filter((id) => !expected.has(id));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `react-native-fetch case coverage is incomplete; missing=${missing.join(",") || "none"}; ` +
      `unexpected=${unexpected.join(",") || "none"}.`,
    );
  }
}

export function frameworkCaseTitle(id: FrameworkCaseID): string {
  const descriptor = FRAMEWORK_CASES.find((candidate) => candidate.id === id);
  if (descriptor === undefined) throw new Error(`Unknown framework conformance case: ${id}`);
  return `[${descriptor.id}] ${descriptor.title}`;
}

export function reactNativeFrameworkCaseTitle(id: ReactNativeFrameworkCaseID): string {
  const descriptor = REACT_NATIVE_FRAMEWORK_CASES.find((candidate) => candidate.id === id);
  if (descriptor === undefined) throw new Error(`Unknown React Native framework case: ${id}`);
  return `[${descriptor.id}] ${descriptor.title}`;
}

function frameworkCase(id: FrameworkCaseID, title: string): FrameworkCaseDescriptor {
  return { id, title, framework: "react-native-fetch" };
}

function reactNativeCase(
  id: ReactNativeFrameworkCaseID,
  title: string,
): ReactNativeFrameworkCaseDescriptor {
  return { id, title, framework: "react-native-fetch" };
}

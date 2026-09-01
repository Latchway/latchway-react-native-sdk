import type { NativeLatchwayModule } from "../../src/testing.js";

export interface CapturedNativeRequest {
  readonly url: URL;
  readonly method: string;
  readonly feature: string;
  readonly headers: Headers;
  readonly body: Readonly<Record<string, unknown>>;
  readonly operationID: string;
  readonly encoded: string;
}

export interface NativeFrameworkReply {
  readonly status?: number;
  readonly statusText?: string;
  readonly headers?: readonly (readonly [string, string])[];
  readonly chunks?: readonly string[];
  /** Keeps the native pull pending until JavaScript cancellation wins. */
  readonly pendingRead?: boolean;
}

export type NativeFrameworkResponder = (
  request: CapturedNativeRequest,
  dispatch: number,
) => NativeFrameworkReply | Promise<NativeFrameworkReply>;

interface ActiveResponse {
  readonly chunks: string[];
  readonly pendingRead: boolean;
}

interface NativeRequestInput {
  url: string;
  method: string;
  feature: string;
  headers: Array<[string, string]>;
  bodyBase64: string | null;
}

const REQUEST_ID = "req_framework_case_123";

/**
 * Deterministic fake of the opaque TurboModule boundary. It never fabricates
 * native credentials; it records only the public request description that the
 * real bridge accepts and pull-streams fixture response bytes back to JS.
 */
export class NativeFrameworkGateway implements NativeLatchwayModule {
  readonly requests: CapturedNativeRequest[] = [];
  readonly cancelCalls: string[] = [];
  readonly closeCalls: string[] = [];
  readonly configureInputs: Readonly<Record<string, unknown>>[] = [];
  readonly nativeSessionEvents: string[] = [];
  refreshCalls = 0;
  automaticRefreshCalls = 0;
  disposeCalls = 0;
  private nextResponse = 1;
  private readonly active = new Map<string, ActiveResponse>();
  private frameworkID = "";
  private frameworkVersion = "";
  private sessionExpired = false;

  constructor(private responder: NativeFrameworkResponder = defaultFrameworkReply) {}

  setResponder(responder: NativeFrameworkResponder): void {
    this.responder = responder;
  }

  expireNativeSession(): void {
    this.sessionExpired = true;
  }

  async configure(_clientID: string, configurationJSON: string): Promise<string> {
    const configuration = JSON.parse(configurationJSON) as Readonly<Record<string, unknown>>;
    if (typeof configuration.frameworkID !== "string" ||
        typeof configuration.frameworkVersion !== "string") {
      throw new Error("Native framework metadata is missing from the React Native configuration.");
    }
    this.frameworkID = configuration.frameworkID;
    this.frameworkVersion = configuration.frameworkVersion;
    this.configureInputs.push(configuration);
    return JSON.stringify({
      platform: "react_native_ios",
      nativeSDKVersion: "1.0.0",
      contractVersion: configuration.contractVersion,
      protocolVersion: configuration.protocolVersion,
    });
  }

  async configureComponent(): Promise<string> {
    throw new Error("The framework fixture does not configure component clients.");
  }

  async startRequest(
    _clientID: string,
    operationID: string,
    _identityToken: string,
    requestJSON: string,
  ): Promise<string> {
    if (this.sessionExpired) {
      this.nativeSessionEvents.push("automatic-pre-dispatch-refresh");
      this.automaticRefreshCalls += 1;
      this.sessionExpired = false;
    }
    this.nativeSessionEvents.push("data-plane-dispatch");
    const input = JSON.parse(requestJSON) as NativeRequestInput;
    const headers = new Headers(input.headers);
    headers.set("X-Latchway-Framework", this.frameworkID);
    headers.set("X-Latchway-Framework-Version", this.frameworkVersion);
    const captured: CapturedNativeRequest = {
      url: new URL(input.url),
      method: input.method,
      feature: input.feature,
      headers,
      body: decodeBody(input.bodyBase64),
      operationID,
      encoded: requestJSON,
    };
    this.requests.push(captured);
    const reply = await this.responder(captured, this.requests.length);
    const responseID = `rsp_${String(this.nextResponse++).padStart(16, "0")}`;
    this.active.set(responseID, {
      chunks: [...(reply.chunks ?? [JSON.stringify({ ok: true })])],
      pendingRead: reply.pendingRead === true,
    });
    return JSON.stringify({
      responseID,
      status: reply.status ?? 200,
      statusText: reply.statusText ?? "",
      headers: reply.headers ?? [
        ["content-type", "application/json"],
        ["x-latchway-request-id", REQUEST_ID],
      ],
    });
  }

  async readResponseChunk(
    _clientID: string,
    _operationID: string,
    responseID: string,
    _maximumBytes: number,
  ): Promise<string> {
    const response = this.active.get(responseID);
    if (response === undefined) throw new Error("The response handle is not active.");
    if (response.pendingRead) return new Promise(() => {});
    const chunk = response.chunks.shift();
    if (chunk === undefined) return JSON.stringify({ done: true });
    return JSON.stringify({
      done: false,
      chunk: bytesToBase64(new TextEncoder().encode(chunk)),
    });
  }

  async closeResponse(_clientID: string, responseID: string): Promise<void> {
    this.closeCalls.push(responseID);
    this.active.delete(responseID);
  }

  async refresh(_clientID: string, _operationID: string, _identityToken: string): Promise<void> {
    this.nativeSessionEvents.push("explicit-refresh");
    this.refreshCalls += 1;
    this.sessionExpired = false;
  }

  async quota(
    _clientID: string,
    _operationID: string,
    _identityToken: string,
    feature: string,
  ): Promise<string> {
    return JSON.stringify({
      feature,
      observed_at: "2026-08-31T00:00:00Z",
      limits: [{ metric: "requests", maximum: 10, remaining: 9, hard: true }],
    });
  }

  async diagnostics(): Promise<string> {
    return JSON.stringify({
      contractVersion: "1.0.0",
      protocolVersion: 2,
      keyStorage: "secure_enclave",
      attestation: { support: "supported", provider: "app_attest", trustLevel: "app_verified" },
      session: { state: "active", refreshAvailable: true },
      installation: { id: "ins_0000000000000001", status: "active" },
      server: { version: "1.0.0", lastRequestID: REQUEST_ID },
    });
  }

  async establishDirectAttestation(): Promise<void> {
    throw new Error("The framework fixture does not attest components.");
  }

  async componentDiagnostics(): Promise<string> {
    throw new Error("The framework fixture does not expose component diagnostics.");
  }

  async prepareComponents(): Promise<string> {
    throw new Error("The framework fixture does not provision native iOS components.");
  }

  async replaceComponent(): Promise<string> {
    throw new Error("The framework fixture does not replace native iOS components.");
  }

  async rootComponentDiagnostics(): Promise<string> {
    throw new Error("The framework fixture does not inspect native iOS components.");
  }

  async revokeComponent(): Promise<void> {
    throw new Error("The framework fixture does not revoke native iOS components.");
  }

  async revoke(): Promise<void> {}

  async revokeFamily(): Promise<void> {}

  async revokeFamilyWithComponents(): Promise<void> {
    throw new Error("The framework fixture does not retire native iOS component descriptors.");
  }

  cancel(_clientID: string, operationID: string): void {
    this.cancelCalls.push(operationID);
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    this.active.clear();
  }
}

export function defaultFrameworkReply(request: CapturedNativeRequest): NativeFrameworkReply {
  if (request.url.pathname === "/v1/embeddings") return embeddingReply();
  if (request.url.pathname === "/v1/messages") return anthropicReply();
  if (request.body.stream === true) return streamingChatReply();
  if (request.url.pathname === "/v1/responses") return responsesReply(request.body);
  return chatReply(request.body);
}

export function responsesReply(body: Readonly<Record<string, unknown>> = {}): NativeFrameworkReply {
  const output = hasStructuredOutput(body)
    ? JSON.stringify({ summary: "hello from Latchway" })
    : "hello from Latchway";
  return jsonReply({
    id: "resp_latchway",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    model: "latchway",
    output: [{
      id: "msg_latchway",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: output, annotations: [], logprobs: [] }],
    }],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 3,
    },
  });
}

export function chatReply(body: Readonly<Record<string, unknown>> = {}): NativeFrameworkReply {
  const tools = Array.isArray(body.tools) && body.tools.length > 0;
  const structured = hasStructuredOutput(body);
  return jsonReply({
    id: "chatcmpl_latchway",
    object: "chat.completion",
    created: 1,
    model: "latchway",
    choices: [{
      index: 0,
      message: tools ? {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_latchway",
          type: "function",
          function: { name: "lookup_weather", arguments: JSON.stringify({ city: "Da Nang" }) },
        }],
      } : {
        role: "assistant",
        content: structured
          ? JSON.stringify({ summary: "hello from Latchway" })
          : "hello from Latchway",
      },
      finish_reason: tools ? "tool_calls" : "stop",
      logprobs: null,
    }],
    usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
  });
}

export function embeddingReply(): NativeFrameworkReply {
  return jsonReply({
    object: "list",
    data: [{ object: "embedding", embedding: [0.25, 0.75], index: 0 }],
    model: "latchway",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
}

export function anthropicReply(): NativeFrameworkReply {
  return jsonReply({
    id: "msg_latchway",
    type: "message",
    role: "assistant",
    model: "latchway",
    content: [{ type: "text", text: "hello from Latchway", citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 2 },
  });
}

export function streamingChatReply(): NativeFrameworkReply {
  const events = [
    { choices: [{ index: 0, delta: { role: "assistant", content: "hello " }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "from Latchway" }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  ];
  return {
    headers: [
      ["content-type", "text/event-stream"],
      ["x-latchway-request-id", REQUEST_ID],
    ],
    chunks: [
      ...events.map((event) => `data: ${JSON.stringify({
        id: "chatcmpl_latchway",
        object: "chat.completion.chunk",
        created: 1,
        model: "latchway",
        ...event,
      })}\n\n`),
      "data: [DONE]\n\n",
    ],
  };
}

export function latchwayProblem(
  code: "quota_exceeded" | "session_expired" | "upstream_unavailable",
): NativeFrameworkReply {
  const policy = {
    quota_exceeded: { status: 429, title: "Quota exceeded", retryable: true },
    session_expired: { status: 401, title: "Session expired", retryable: true },
    upstream_unavailable: { status: 503, title: "Upstream unavailable", retryable: true },
  }[code];
  const documentationURL = `https://docs.latchway.dev/errors/${code.replaceAll("_", "-")}`;
  return jsonReply({
    type: documentationURL,
    documentation_url: documentationURL,
    title: policy.title,
    status: policy.status,
    detail: `Conformance ${code.replaceAll("_", " ")}.`,
    code,
    request_id: REQUEST_ID,
    retryable: policy.retryable,
  }, policy.status, "application/problem+json", [["retry-after", "0"]]);
}

export function providerError(): NativeFrameworkReply {
  return jsonReply({
    error: {
      message: "The selected upstream is temporarily unavailable.",
      type: "upstream_error",
      code: "upstream_unavailable",
    },
  }, 502);
}

function jsonReply(
  value: unknown,
  status = 200,
  contentType = "application/json",
  extraHeaders: readonly (readonly [string, string])[] = [],
): NativeFrameworkReply {
  return {
    status,
    headers: [
      ["content-type", contentType],
      ["x-latchway-request-id", REQUEST_ID],
      ...extraHeaders,
    ],
    chunks: [JSON.stringify(value)],
  };
}

function decodeBody(bodyBase64: string | null): Readonly<Record<string, unknown>> {
  if (bodyBase64 === null) return {};
  const bytes = Uint8Array.from(atob(bodyBase64), (character) => character.charCodeAt(0));
  const decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("A framework request did not contain a JSON object.");
  }
  return decoded as Readonly<Record<string, unknown>>;
}

function hasStructuredOutput(body: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(body, "response_format") || Object.hasOwn(body, "text");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

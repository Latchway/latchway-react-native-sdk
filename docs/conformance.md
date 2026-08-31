# Conformance

Node conformance validates JavaScript request shaping with the explicit testing bridge, malicious credential-field output rejection, native response pull/backpressure, strict-CSP safety, redaction, cancellation, version mismatch, cross-instance coordination, and canonical contract fixtures. It does not emulate hardware trust or assert that a production native transport attached a valid proof.

The framework suite under `Conformance/framework` uses 16 applicable stable
`FW-*` case IDs from the JavaScript SDK suite and binds them to the canonical
`react-native-fetch` registry entry. It executes, rather than merely imports,
the exact OpenAI 7.8.0, Vercel AI 7.0.85, and LangChain OpenAI 1.5.10 consumer
paths. RN-specific `RN-FW-ANTHROPIC-001` separately runs
`@ai-sdk/anthropic` 4.0.46 against `/v1/messages`, without claiming a canonical
Anthropic framework registry entry. The official `@anthropic-ai/sdk` 0.120.0
client is recorded as unsupported because its credential-chain Node filesystem
imports fail an actual Metro bundle. The deterministic native-boundary fixture
returns protocol-shaped Responses, Chat Completions, Anthropic Messages,
embeddings, SSE usage, tool calls, structured output, quota failures, provider
failures, and retry responses. Tests prove feature binding, safe headers,
request-ID correlation, cancellation, fresh native operation IDs for framework
retries, placeholder stripping, exact-origin refusal, and isolation from global
fetch.

`RN-FW-REFRESH-001` separately proves the public explicit-refresh operation
followed by a framework request. It is intentionally not reported as shared
`FW-BEH-006`: automatic recovery from a pre-dispatch expired native session is
owned by the platform SDK and requires native/device evidence.

`RN-FW-OPAQUE-001` proves the bounded `/proxy/{feature}/...` pathway keeps its
feature binding through native dispatch. None of the RN-only cases extends the
shared `FW-*` registry set.

This suite deliberately does not manufacture DPoP proofs, refresh credentials,
or platform attestation in JavaScript. Fresh-proof generation and native
pre-dispatch retry classification remain native SDK/device evidence. The local
framework result therefore supports the registry's `experimental` state; it is
not hosted or physical-device release evidence.

Real platform conformance requires the exact core image and real provider configuration:

- iOS: App Attest development and production applications on physical devices; session creation, assertion reuse, nonce, refresh rotation, quota, streaming, diagnostics, and revocation.
- Android: Play-distributed application with Play Integrity standard requests; hardware/StrongBox policy variants, nonce, refresh rotation, quota, streaming, diagnostics, and revocation.
- Both: identity token expiry/reauthentication, installation platform validation, no secret material in errors/diagnostics, and published native dependency resolution.

Provider credentials and signing material belong in protected CI/device infrastructure and are never committed. Missing provider credentials block device conformance only; they do not justify fake evidence or trusted identity fields.

The production TurboModule intentionally cannot expose or mutate DPoP/session
credentials for a JavaScript evidence harness. Replay, proof tamper, session
credential rotation, and protocol-header mutation therefore have to be taken
from the separately linked native SDK physical-device reports. The v2 raw
React Native record omits those native-only claims. Its protected finalizer
validates the hash-pinned platform-native report, imports only the five exact
allowlisted proof objects, and rejects missing, failed, renamed, extended, or
coordinate-substituted proofs. The React Native report remains ineligible
unless all of its own runtime checks pass (eight on iOS, including direct
assertion reuse; seven on Android) and every imported proof passes.

The repository's native source jobs build official React Native 0.82 iOS and
Android hosts against the exact locked SDK source releases. The published
dependency jobs repeat those builds with local CocoaPods paths and Maven
repositories removed. Neither is physical-device attestation evidence.

Before v1 is called device-conformant, retain redacted run evidence for each
platform/provider/environment combination covering installation creation,
session reuse, identity expiry and reauthentication, nonce recovery, refresh
rotation, quota, an SSE stream, diagnostics, revocation, and a post-revocation
re-enrollment. The evidence must name the application release, device/OS,
gateway image digest, contract bundle hash, SDK package versions, and request
IDs without including tokens, proofs, keys, or raw attestations.

# Conformance

Node conformance validates JavaScript request shaping with the explicit testing bridge, malicious credential-field output rejection, native response pull/backpressure, strict-CSP safety, redaction, cancellation, version mismatch, cross-instance coordination, and canonical contract fixtures. It does not emulate hardware trust or assert that a production native transport attached a valid proof.

Real platform conformance requires the exact core image and real provider configuration:

- iOS: App Attest development and production applications on physical devices; session creation, assertion reuse, nonce, refresh rotation, quota, streaming, diagnostics, and revocation.
- Android: Play-distributed application with Play Integrity standard requests; hardware/StrongBox policy variants, nonce, refresh rotation, quota, streaming, diagnostics, and revocation.
- Both: identity token expiry/reauthentication, installation platform validation, no secret material in errors/diagnostics, and published native dependency resolution.

Provider credentials and signing material belong in protected CI/device infrastructure and are never committed. Missing provider credentials block device conformance only; they do not justify fake evidence or trusted identity fields.

The production TurboModule intentionally cannot expose or mutate DPoP/session
credentials for a JavaScript evidence harness. Replay, proof tamper, session
credential rotation, and protocol-header mutation therefore have to be taken
from the separately linked native SDK physical-device reports. Until the raw
React Native evidence schema and finalizer enforce that linkage, those legacy
JavaScript checks remain failed and release promotion remains blocked.

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

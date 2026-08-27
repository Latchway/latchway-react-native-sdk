# Conformance

Node conformance validates JavaScript request shaping with the explicit testing bridge, strict-CSP safety, redaction, cancellation, version mismatch, cross-instance coordination, and canonical contract fixtures. It does not emulate hardware trust.

Real platform conformance requires the exact core image and real provider configuration:

- iOS: App Attest development and production applications on physical devices; session creation, assertion reuse, nonce, refresh rotation, quota, streaming, diagnostics, and revocation.
- Android: Play-distributed application with Play Integrity standard requests; hardware/StrongBox policy variants, nonce, refresh rotation, quota, streaming, diagnostics, and revocation.
- Both: identity token expiry/reauthentication, installation platform validation, no secret material in errors/diagnostics, and published native dependency resolution.

Provider credentials and signing material belong in protected CI/device infrastructure and are never committed. Missing provider credentials block device conformance only; they do not justify fake evidence or trusted identity fields.

# Security Policy

## Release status

Latchway React Native SDK is implemented but remains pre-release. Do not depend
on an unpublished checkout as a supported production security boundary; use a
published version whose native compatibility entry is recorded.

Security fixes will target supported releases once the support matrix is
established. The unreleased branch may change without compatibility guarantees.

## Reporting a vulnerability

Use GitHub private vulnerability reporting for this repository. If that feature
is unavailable, contact the Latchway organization maintainers privately before
sharing details. Do not open a public issue for a suspected vulnerability.

Do not include live identity tokens, refresh tokens, DPoP proofs, attestation
evidence, private keys, signing assets, provider credentials, or user data in a
report. Revoke exposed credentials before continuing.

A useful report includes:

- The affected revision or released version
- The React Native, iOS or Android, and device versions
- Reproduction steps using synthetic or redacted data
- The expected and observed security behavior
- Impact, prerequisites, and any known mitigations

## Security-sensitive scope

Treat changes to TurboModule boundaries, native-to-JavaScript data exposure,
installation state, native SDK version resolution, request retry/replay
behavior, token redaction, and diagnostics as security-sensitive. Hardware keys,
attestation, DPoP signing, refresh-token storage, and installation state belong
to the native SDKs and must not be reimplemented in JavaScript or C++ here.

The application-owned external identity token crosses the TurboModule boundary
only for the duration of a native operation. Private keys, refresh tokens, raw
attestation evidence, attestation challenge bindings, and native session state
must never enter JavaScript. The access token and DPoP proof necessarily return
inside a short-lived authorization envelope so React Native fetch can attach
them to the exact-origin request; they are not exposed as standalone public
values, persisted, or included in diagnostics and errors.

The SDK must never accept an upstream AI-provider secret. Latchway server or
native-SDK vulnerabilities should be reported to their owning repository, with
a cross-reference here when bridge behavior is involved.

## Disclosure

Allow maintainers a reasonable opportunity to investigate and coordinate a fix
before public disclosure. Good-faith research that avoids privacy violations,
service disruption, and access beyond what is necessary is welcome.

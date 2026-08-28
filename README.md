# Latchway React Native SDK

`@latchway/react-native` gives iOS and Android applications one fetch-shaped API for a self-hosted Latchway gateway. The JavaScript layer never accepts an upstream AI-provider key. P-256 installation keys, DPoP signing, refresh-token storage, and platform attestation stay in the native Latchway SDKs.

> **Release status:** `0.1.0-dev.0` is implemented and tested from source, but has not been published. Use a workspace dependency or the archive produced by `pnpm pack:check`; do not assume an npm or native artifact exists until the release is announced.

## Requirements

- React Native 0.82 or newer with the New Architecture enabled
- iOS 15 or newer, an App Attest-capable application entitlement, and `Latchway/AppAttest` 0.1.0
- Android API 24 or newer, Play Integrity configured for the application, and the `dev.latchway` 0.1.0 artifacts
- Node 24.19.0 and pnpm 10.15.0 for repository development

## Usage

```ts
import { createLatchwayClient } from "@latchway/react-native";

const latchway = createLatchwayClient({
  baseURL: "https://gateway.example.com",
  applicationID: "app_habitify",
  environment: "production",
  getIdentityToken: async () => {
    const token = await applicationIdentity.currentToken();
    if (token === undefined) throw new Error("The user must sign in before calling Latchway.");
    return token;
  },
  android: {
    playIntegrityCloudProjectNumber: applicationConfiguration.googleCloudProjectNumber,
  },
});

const response = await latchway.fetch("/v1/chat/completions", {
  method: "POST",
  latchwayFeature: "habit_assistant",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "assistant-default",
    messages: [{ role: "user", content: "Plan tomorrow" }],
  }),
});
```

Call `dispose()` when the owning application scope is destroyed. Disposal drops the in-memory native client; secure installation state remains available to later instances. `revokeCurrentInstallation()` is the explicit server and local secure-state destruction operation.

Equivalent clients in one JavaScript runtime share one native client and contract compatibility check. Native SDK actors/mutexes own session establishment and refresh single-flight. Bodyless `GET`, `HEAD`, and `OPTIONS` requests receive at most one pre-dispatch retry only when a `401 application/problem+json` body exactly matches the canonical `session_expired` or `dpop_nonce_required` problem definition and its request ID agrees with the response header. A nonce retry additionally requires one unambiguous bounded `DPoP-Nonce`; a session rejection carrying that header is not replayed. Requests with bodies are never cloned or replayed by the JavaScript wrapper.

`errorFromResponse` is re-exported for explicit conversion of a returned problem response. An `operation_indeterminate` error includes a required canonical `operationID`; preserve it with the request ID and reconcile the operation before deciding whether to retry.

## Security boundary

The only application credential sent into the TurboModule is the external identity JWT returned by `getIdentityToken`, and it is retained only for the duration of the native operation. The bridge does not accept App Attest objects, Play Integrity tokens, `client_data_hash`, request hashes, DPoP private keys, access tokens, or refresh tokens as inputs. Authorization and DPoP headers cross back only as short-lived output needed for the JavaScript-owned fetch dispatch; diagnostics and errors never include them.

Caller-supplied `Authorization`, `DPoP`, cookies, API-key headers, and Latchway protocol headers are removed before authorization. Provider-credential query names are rejected, including percent-encoded and case-varied names. Only the configured gateway origin can be authorized, redirects are rejected, and insecure HTTP is limited to explicitly enabled loopback conformance.

See [native installation](docs/native-installation.md), [security details](docs/security.md), and [architecture](docs/architecture.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm pack:check
pnpm verify:reproducible
```

`pnpm codegen:check` parses the handwritten TurboModule spec and regenerates both platform surfaces in a disposable directory. Node tests use the explicit `@latchway/react-native/testing` bridge; production applications must never install a test bridge.

The example in [`example`](example/README.md) demonstrates Firebase Authentication, environment-supplied deployment configuration, fetch, quota, diagnostics, and lifecycle cleanup without storing or logging credentials.

## Contract lock

This release consumes contract `0.4.0`, wire protocol `1`, core commit `c9347421fac4c729f20ea87f9205c66c15fa983f`, and bundle SHA-256 `39d32a2c9e4b0381ff815a40d87d75b51e4f37d6de55121b7bb0beef690c5c59`. `pnpm verify:contracts` checks the lock and vendored canonical fixtures byte-for-byte.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

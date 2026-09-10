# Latchway React Native SDK

One fetch-shaped API for a self-hosted Latchway gateway, with shared native/RN
accounts and application-supplied identity. Either native or React Native can
configure first. Matching configuration reuses the same native app and account;
no native authentication coordinator or Firebase dependency is required.

**Version 2.0.0** removes legacy constructors, identity-authority setup, and old
storage migration paths. It retains app-level `signOut()` and the native Fetch
response parsing fix. Rebuild JavaScript and native apps together; this is not
an over-the-air JavaScript-only upgrade. Historical releases remain unchanged.

Installation keys, DPoP signing, refresh credentials and App Attest/Play Integrity
stay in the native SDKs. The SDK never accepts an upstream AI-provider key.

## Configure and use

```ts
import {Latchway, firebaseProject} from '@latchway/react-native';

const app = await Latchway.configure({
  baseURL: 'https://gateway.example.com',
  applicationID: 'app_01J00000000000000000000000',
  environment: 'production',
  identity: firebaseProject({projectID: 'your-project-id'}),
  apple: {rootKeychainAccessGroup: 'YOURTEAM.com.example.app'},
  android: {playIntegrityCloudProjectNumber: '123456789012'},
});

const account = await app.signIn({
  getIdToken: () => yourAuth.getIdToken(),
});
const client = await account.makeClient();

const response = await client.fetch('/v1/responses', {
  method: 'POST',
  latchwayFeature: 'assistant',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({model: 'server-configured', input: 'Hello'}),
});
```

The application owns `yourAuth`. `firebaseProject` formats public issuer/audience
metadata only; it imports no Firebase module and obtains no token. Generic
identity uses `{providerID, issuer, audience, tenantID?}` configured on the gateway.
Use the actual signed root-private Keychain group, not a guessed Team ID prefix.

`configure` never logs in. On application-auth restoration, call
`app.restore({getIdToken})`; a persisted logout requires an accepted new login
through `signIn`. Another surface can attach with `app.makeClient()` without
another sign-in.

```ts
await account.updateIdToken({getIdToken: () => yourAuth.getIdToken()});
await app.signOut(); // Current account and unfinished cleanup; native/RN fenced.
// Your application signs out its external auth provider separately.
await client.dispose(); // Releases this surface only; not shared logout.
```

Acquisition callbacks are one-shot and cancellation-aware, not permanent JS
identity owners. Native memory holds only gateway-verified fresh identity.
Expiry suspends work with `identity_refresh_required`; a same-account update
resumes it. Old handles cannot follow a different login. Report all external
auth changes and keep application login/logout mutations serialized.

See [supplied identity](docs/supplied-identity.md) and
[shared native apps](docs/shared-native-apps.md) for complete lifecycle examples.

## Requirements and installation

- React Native `>=0.74.0 <1.0.0`, New Architecture, and React `^18.2.0 || ^19.0.0`.
  Pair React with the version required by the selected RN release.
- iOS 15 or newer, the signed root-private Keychain group, and a physical
  App Attest-capable device for real attestation.
- Android API 24 or newer, with Play Integrity configured for the signed app.
  Native libraries use compile SDK 34; other host dependencies may require more.
- Server 1.1.1 or later, contract 1.1.0 / wire 3, `supplied_identity_v1`, and
  explicit required-attestation `sharedNativeCallers` policy.
- Node 24.19+ and pnpm 10.15 for repository development.

Install `@latchway/react-native@2.0.1`, update Pods, and rebuild both native apps.
Native pins are iOS 2.0.1 and Android 1.2.2; the JavaScript client is 1.1.1.
Use one native SDK implementation. RN and native must not link separate iOS
CocoaPods and SPM copies. See [native installation](docs/native-installation.md)
and [minimum-host toolchain](docs/react-native-compatibility.md).

The supported minimum is not a promise that every RN minor or every optional
Firebase/LangChain dependency has been tested. The main example uses RN 0.82 /
React 19.1. The SDK does not install Firebase, LangChain, a Babel plugin or global
polyfills. Its required JavaScript dependencies are `@latchway/client` and a
private `web-streams-polyfill` fallback. Optional integration tooling remains
application-owned; see [LangChain](docs/langchain.md).

## Feature-bound transports

`client.fetchFor(feature)` supplies a normal feature-bound fetch function to
frameworks with custom-fetch support. `gatewayURL` exposes the non-secret
canonical origin. Neither replaces global fetch. The server selects the route
and actual model; each feature must match its request protocol.

Structured routes are POST-only: `/v1/responses`, `/v1/chat/completions`,
`/v1/embeddings` and `/v1/messages`. Opaque requests are restricted to the exact
`/proxy/{feature}/<safe-relative-path>` and allowed methods. Credentials in
headers/query, unsafe paths and redirects fail closed.

Requests are buffered at the bridge with an 8 MiB client ceiling; the gateway
may impose a lower body limit. Responses are pull-streamed with cancellation
and backpressure. JavaScript never replays an authenticated request. Native
transport may retry once only when the canonical server rejection proves no
upstream dispatch. Unknown outcomes and partial responses are not retried.

The supported fetch subset includes method, headers, body, abort, status and
a readable response stream. Browser cookies/cache, service workers, streaming
uploads, redirects and response trailers are not implemented. Framework support
requires its actual React Native-compatible custom-fetch path, not merely an
API shaped like fetch. See [LangChain examples](docs/langchain.md).

## Apple components

Current delegated components remain supported. Declare authorized groups in
`apple.sharedKeychainAccessGroups` at first registration, distinct from the
root-private group. Host component provisioning, replacement, diagnostics and
revocation operate through the captured account's client. An extension requires
an explicit non-secret account handoff and retains its own key and delegated
session; it never receives root credentials.

iOS application extensions cannot generate App Attest keys. They are
delegated-only; the containing app must not attest on their behalf. Current
root/component retirement journals, cross-process revision checks and account
cancellation remain enforced. See [native installation](docs/native-installation.md).

## Storage and security

Current source starts in account-scoped storage. It does not scan/import
earlier SDK sessions or accept old-store inventory and cleanup callbacks.
Logout persists retirement, fences buffered bytes and preserves retryable local
cleanup. It does not reset server per-user quotas or revoke other devices.

External ID tokens are the only application credentials supplied to the native
identity operation. Refresh/access tokens, DPoP proofs, private keys and
attestation evidence never return to JavaScript. Caller-owned authorization,
cookies, provider API keys and protocol headers are rejected or stripped;
a provider SDK's placeholder key is never forwarded.

Errors expose safe gateway messages, codes, status, request IDs, retry-after
times, feature and validation errors, supported protocol versions, titles,
instance references and canonical documentation links when supplied. Unknown
optional fields are ignored, not copied across the boundary. Use
`errorFromResponse(response)` for an unsuccessful custom-fetch response, then
show `error.message` and `error.requestID`; do not log the entire request or body.
An interrupted body read preserves header correlation and is not replayable.
Preserve `operation_indeterminate`'s operation ID for reconciliation
instead of automatic retry. See [security](docs/security.md),
[architecture](docs/architecture.md) and [SECURITY.md](SECURITY.md).

## Examples and verification

[LatchwayChat](Examples/LatchwayChat/README.md) demonstrates app-owned Firebase
login, native-first or RN-first configuration, LangChain weather tools and
temporary streaming chat. It distinguishes registry-release receipts from
source-development and actual device evidence.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm codegen:check
pnpm pack:check
```

Native tests, package resolution and physical device checks are separate.
Use the explicit testing bridge only in tests, never production. Preserve
signed entitlement checks, native protocol fixtures and real-device evidence;
a simulator or local build does not prove App Attest or Play Integrity.
Release procedures are in [releasing](docs/releasing.md).

Local iOS/TestFlight and Android Google testing policies require server 1.1.3+;
see [development attestation](docs/development-attestation.md). App Attest
`any` is a gateway acceptance policy, not an SDK or Apple entitlement value.

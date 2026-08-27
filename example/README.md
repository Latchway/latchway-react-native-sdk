# Example application

This source is intended for a React Native 0.82 New Architecture host named `LatchwayExample`. It uses Firebase Authentication for the app-owned identity JWT and `react-native-config` for non-secret deployment values. The primary action requests an SSE response and consumes `Response.body` incrementally, with a bounded display buffer, so the example exercises the JavaScript-owned streaming path instead of replacing it with a buffered mock.

Configure these values in the host's uncommitted environment:

- `LATCHWAY_BASE_URL`
- `LATCHWAY_APPLICATION_ID`
- `LATCHWAY_ENVIRONMENT`
- `LATCHWAY_FEATURE`
- `LATCHWAY_MODEL`
- `LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER`

Add the normal Firebase iOS/Android configuration files through the provider's protected application setup. Do not commit service-account credentials, identity tokens, App Attest evidence, Play Integrity tokens, session credentials, or provider keys.

For local iOS SDK development, add `pod "Latchway", path: "../../../latchway-ios-sdk"` to the host Podfile. For Android, point `LATCHWAY_NATIVE_REPOSITORY` at a local Maven publication as described in [native installation](../docs/native-installation.md). Release-consumer CI must remove both overrides.

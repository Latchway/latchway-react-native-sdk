import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  SDK_VERSION,
  createLatchwayClient,
  Latchway,
  firebaseProject,
  jwtIdentity,
  bindLatchwayAuth,
  type LatchwayClient,
} from "@latchway/react-native";
import type { LatchwayErrorCode } from "@latchway/client";

export const client: LatchwayClient = createLatchwayClient({
  baseURL: "https://gateway.example.com",
  applicationID: "app_package_consumer",
  environment: "development",
  getIdentityToken: async () => "fixture.identity.token",
  android: { playIntegrityCloudProjectNumber: "123456789012" },
});

export const compatibility = {
  contract: CONTRACT_VERSION,
  gateway: client.gatewayURL,
  protocol: PROTOCOL_VERSION,
  sdk: SDK_VERSION,
} as const;

export const expectedError: LatchwayErrorCode = "client_configuration_invalid";

// Public supplied-identity API must type-check from the packed npm declarations.
export async function configureFirst(idToken: string) {
  const app = await Latchway.configure({
    baseURL: "https://gateway.example.com", applicationID: "app_package_consumer",
    environment: "development", identity: firebaseProject({projectID: "demo-project"}),
    android: {playIntegrityCloudProjectNumber: "123456789012"},
  });
  const account = await app.signIn({idToken});
  await account.updateIdToken({getIdToken: async () => idToken});
  const transport = await account.makeClient();
  const binding = await bindLatchwayAuth(app, {subscribe: () => () => undefined, onError: () => undefined});
  await binding.dispose();
  return {app, account, transport, metadata: jwtIdentity({providerID: "jwt", issuer: "https://auth.example.com", audience: "mobile"})};
}

// Type/package consumer acceptance only. No implicit activation or auth owner.
export async function sharedNativeSurface() {
  const app = await Latchway.getApp("native-host");
  const snapshot = await app.snapshot();
  if (snapshot.state !== "active") return undefined;
  const accountClient = await app.makeClient();
  return {client: accountClient, close: () => accountClient.dispose(),
    logout: () => accountClient.logout()};
}

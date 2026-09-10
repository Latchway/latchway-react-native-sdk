import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  SDK_VERSION,
  Latchway,
  firebaseProject,
  jwtIdentity,
  bindLatchwayAuth,
  createLatchwayComponentClient,
} from "@latchway/react-native";
import type * as PublicSDK from "@latchway/react-native";
import type {LatchwayApp, LatchwayAppOptions, LatchwayAppSnapshot, LatchwayClient, LatchwayComponentOptions} from "@latchway/react-native";
import type { LatchwayErrorCode } from "@latchway/client";

export const compatibility = {
  contract: CONTRACT_VERSION,
  protocol: PROTOCOL_VERSION,
  sdk: SDK_VERSION,
} as const;

export const expectedError: LatchwayErrorCode = "client_configuration_invalid";

type Assert<T extends true> = T;
export type FreshOnlySurface = [
  Assert<"createLatchwayClient" extends keyof typeof PublicSDK ? false : true>,
  Assert<"activate" extends keyof LatchwayApp ? false : true>,
  Assert<"transferIdentityAuthority" extends keyof LatchwayApp ? false : true>,
  Assert<"getIdentitySnapshot" extends keyof LatchwayAppOptions ? false : true>,
  Assert<"authorityInstanceID" extends keyof LatchwayAppSnapshot ? false : true>,
  Assert<"legacySharedKeychainAccessGroups" extends keyof NonNullable<LatchwayAppOptions["apple"]> ? false : true>,
  Assert<"apple" extends keyof LatchwayComponentOptions ? false : true>,
  Assert<{} extends Pick<LatchwayComponentOptions, "account"> ? false : true>,
  Assert<typeof PROTOCOL_VERSION extends 3 ? true : false>,
];

// Public supplied-identity API must type-check from the packed npm declarations.
export async function configureFirst(idToken: string) {
  const app = await Latchway.configure({
    baseURL: "https://gateway.example.com", applicationID: "app_01J00000000000000000000000",
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
  const account = await app.currentAccount();
  if (!account) return undefined;
  const accountClient = await account.makeClient();
  return {client: accountClient, close: () => accountClient.dispose(),
    logout: () => accountClient.logout()};
}

// Type-only acceptance of the non-secret, account-bound extension handoff.
export async function componentSurface(client: LatchwayClient) {
  const account = await client.componentAccount();
  return createLatchwayComponentClient({
    baseURL: "https://gateway.example.com", applicationID: "app_01J00000000000000000000000",
    environment: "development", account,
    component: {definitionID: "widget", kind: "widget", keychainAccessGroup: "TEAM.example.shared", requestedFeatures: ["assistant"]},
  });
}

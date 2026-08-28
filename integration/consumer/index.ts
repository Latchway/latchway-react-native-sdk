import {
  CONTRACT_VERSION,
  PROTOCOL_VERSION,
  SDK_VERSION,
  createLatchwayClient,
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
  protocol: PROTOCOL_VERSION,
  sdk: SDK_VERSION,
} as const;

export const expectedError: LatchwayErrorCode = "client_configuration_invalid";

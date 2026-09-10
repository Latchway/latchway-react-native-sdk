import { configureLatchwayApp, type LatchwayAppOptions } from "../src/app.js";
import type { LatchwayClient } from "../src/types.js";

/** The transport fixture joins a mocked, already authenticated native account. */
export function sharedFixtureClient(options: LatchwayAppOptions): LatchwayClient {
  let connected: LatchwayClient | undefined;
  const pending = configureLatchwayApp(options).then(async app => {
    const account = await app.currentAccount();
    if (account === null) throw new Error("The native test account is inactive.");
    connected = await account.makeClient();
    return connected;
  });
  // The proxy only makes the async public account bootstrap convenient for
  // synchronous framework constructors. No test-only production factory exists.
  return new Proxy({ gatewayURL: options.baseURL.replace(/\/$/u, ""),
    ready: pending.then(client => client.ready),
    fetchFor: (feature: string) => (input: RequestInfo | URL, init?: RequestInit) =>
      pending.then(client => client.fetchFor(feature)(input, init)),
  }, { get(target, key) {
    if (connected !== undefined && typeof Reflect.get(connected, key) === "function") {
      return (Reflect.get(connected, key) as (...args: unknown[]) => unknown).bind(connected);
    }
    if (key in target) return Reflect.get(target, key) as unknown;
    return (...args: unknown[]) => pending.then(client =>
      Reflect.apply(Reflect.get(client, key) as (...values: unknown[]) => unknown, client, args));
  } }) as LatchwayClient;
}

export const sharedDescriptor = {
  nativeAppABI: 3, identityMode: "supplied", contractVersion: "1.1.0", protocolVersion: 3,
  nativeSDKVersion: "1.2.0", platform: "react_native_ios",
  baseURL: "https://gateway.example.test", applicationID: "app_01J00000000000000000000000", environment: "production",
  appInstanceID: "0e5244a0-4c04-4bcf-a4da-6102a25ad8c1", generationID: "58da9766-77db-42a0-a4dd-b0f71abae5db",
  state: "active", revision: 1,
  componentKeychainAccessGroups: ["ABCDE12345.com.example.app.shared"],
};

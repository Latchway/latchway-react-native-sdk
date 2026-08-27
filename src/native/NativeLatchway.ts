import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  configure(clientID: string, configurationJSON: string): Promise<string>;
  authorize(
    clientID: string,
    operationID: string,
    identityToken: string,
    requestJSON: string,
  ): Promise<string>;
  refresh(clientID: string, operationID: string, identityToken: string): Promise<void>;
  quota(
    clientID: string,
    operationID: string,
    identityToken: string,
    feature: string,
  ): Promise<string>;
  diagnostics(clientID: string, operationID: string, identityToken: string): Promise<string>;
  revoke(clientID: string, operationID: string, identityToken: string): Promise<void>;
  cancel(clientID: string, operationID: string): void;
  dispose(clientID: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("NativeLatchway");

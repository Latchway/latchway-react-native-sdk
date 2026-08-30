import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  configure(clientID: string, configurationJSON: string): Promise<string>;
  configureComponent(
    clientID: string,
    configurationJSON: string,
    componentJSON: string,
  ): Promise<string>;
  startRequest(
    clientID: string,
    operationID: string,
    identityToken: string,
    requestJSON: string,
  ): Promise<string>;
  readResponseChunk(
    clientID: string,
    operationID: string,
    responseID: string,
    maximumBytes: number,
  ): Promise<string>;
  closeResponse(clientID: string, responseID: string): Promise<void>;
  refresh(clientID: string, operationID: string, identityToken: string): Promise<void>;
  quota(
    clientID: string,
    operationID: string,
    identityToken: string,
    feature: string,
  ): Promise<string>;
  diagnostics(clientID: string, operationID: string, identityToken: string): Promise<string>;
  establishDirectAttestation(
    clientID: string,
    operationID: string,
  ): Promise<void>;
  componentDiagnostics(
    clientID: string,
    operationID: string,
  ): Promise<string>;
  revoke(clientID: string, operationID: string, identityToken: string): Promise<void>;
  revokeFamily(clientID: string, operationID: string, identityToken: string): Promise<void>;
  cancel(clientID: string, operationID: string): void;
  dispose(clientID: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("NativeLatchway");

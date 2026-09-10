import type { TurboModule } from "react-native";
import { TurboModuleRegistry } from "react-native";

export interface Spec extends TurboModule {
  appCommand(commandJSON: string): Promise<string>;
  configureComponent(
    clientID: string,
    configurationJSON: string,
    componentJSON: string,
  ): Promise<string>;
  startRequest(
    clientID: string,
    operationID: string,
    requestJSON: string,
  ): Promise<string>;
  readResponseChunk(
    clientID: string,
    operationID: string,
    responseID: string,
    maximumBytes: number,
  ): Promise<string>;
  closeResponse(clientID: string, responseID: string): Promise<void>;
  refresh(clientID: string, operationID: string): Promise<void>;
  quota(
    clientID: string,
    operationID: string,
    feature: string,
  ): Promise<string>;
  diagnostics(clientID: string, operationID: string): Promise<string>;
  componentDiagnostics(
    clientID: string,
    operationID: string,
  ): Promise<string>;
  prepareComponents(
    clientID: string,
    operationID: string,
    componentsJSON: string,
  ): Promise<string>;
  replaceComponent(
    clientID: string,
    operationID: string,
    componentJSON: string,
  ): Promise<string>;
  rootComponentDiagnostics(
    clientID: string,
    operationID: string,
    componentJSON: string,
  ): Promise<string>;
  revokeComponent(
    clientID: string,
    operationID: string,
    componentJSON: string,
  ): Promise<void>;
  revoke(clientID: string, operationID: string): Promise<void>;
  revokeFamily(clientID: string, operationID: string): Promise<void>;
  cancel(clientID: string, operationID: string): void;
  dispose(clientID: string): Promise<void>;
}

export default TurboModuleRegistry.getEnforcing<Spec>("NativeLatchway");

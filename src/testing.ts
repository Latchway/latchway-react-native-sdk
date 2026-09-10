import { setTestingNativeModule, type NativeLatchwayModule } from "./native/bridge.js";

/** Installs an in-process bridge for Node conformance tests. Never use this in an application build. */
export function installNativeModuleForTesting(module: NativeLatchwayModule): () => void {
  setTestingNativeModule(module);
  return () => { setTestingNativeModule(undefined); };
}

export type { NativeLatchwayModule };

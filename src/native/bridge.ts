import type { Spec } from "./NativeLatchway.js";

export type NativeLatchwayModule = Spec;

let testingModule: NativeLatchwayModule | undefined;

export async function nativeModule(): Promise<NativeLatchwayModule> {
  if (testingModule !== undefined) return testingModule;
  try {
    return (await import("./NativeLatchway.js")).default;
  } catch (cause) {
    const error = new Error(
      "The Latchway TurboModule is unavailable. Rebuild the native application after installing @latchway/react-native.",
      { cause },
    );
    error.name = "LatchwayNativeModuleUnavailable";
    throw error;
  }
}

export function setTestingNativeModule(module: NativeLatchwayModule | undefined): void {
  testingModule = module;
}

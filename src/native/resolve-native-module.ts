import { TurboModuleRegistry } from "react-native";
import type { Spec } from "./NativeLatchway.js";

/** Keep native construction outside Metro's guarded module-initialization
 * phase, which can report an exception and return an undefined module export.
 * The caller catches the original registry error. No legacy/native fallback. */
export function resolveNativeModule(): Spec {
  return TurboModuleRegistry.getEnforcing<Spec>("NativeLatchway");
}

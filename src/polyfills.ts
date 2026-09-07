/**
 * @deprecated Prefer application-owned setup from docs/langchain.md. Since
 * 1.1.1, this entry requires explicitly installed optional peers:
 * react-native-get-random-values, react-native-url-polyfill, and text-encoding.
 * The base SDK no longer installs these packages for the host application.
 *
 * Explicit, opt-in React Native compatibility bootstrap. Import this before
 * LangChain or any SDK/stream dependency. The ordinary SDK entry has no global
 * initialization side effects. Native keys and attestation are never polyfilled.
 */
import "./runtime-symbols.js";
import "react-native-get-random-values";
import { URL as CompatibleURL, URLSearchParams as CompatibleURLSearchParams } from "react-native-url-polyfill";
import { ReadableStream, TransformStream, WritableStream } from "web-streams-polyfill";
import { TextDecoder, TextEncoder } from "text-encoding";

// React Native's built-in URL is present but incomplete. Replace it only when
// this small capability check fails, retaining complete application polyfills.
function hasWorkingURL(): boolean {
  try {
    const url = new globalThis.URL("child?q=hello%20world", "https://example.invalid/root/");
    const routes = ["/v1/responses", "/v1/chat/completions"];
    // RN's partial URL can parse queries but append a slash to API paths.
    // Read searchParams before href: access must not change serialization.
    return routes.every((path) => {
      const route = new globalThis.URL(`https://example.invalid${path}`);
      return route.href === `https://example.invalid${path}` && route.pathname === path;
    }) &&
      url.searchParams.get("q") === "hello world" &&
      url.href === "https://example.invalid/root/child?q=hello%20world" &&
      new globalThis.URLSearchParams({ q: "hello world" }).get("q") === "hello world";
  } catch {
    return false;
  }
}

if (!hasWorkingURL()) Object.assign(globalThis, { URL: CompatibleURL, URLSearchParams: CompatibleURLSearchParams });
if (typeof globalThis.TextEncoder === "undefined") Object.assign(globalThis, { TextEncoder });
if (typeof globalThis.TextDecoder === "undefined") Object.assign(globalThis, { TextDecoder });
if (typeof globalThis.ReadableStream === "undefined") Object.assign(globalThis, { ReadableStream });
if (typeof globalThis.TransformStream === "undefined") Object.assign(globalThis, { TransformStream });
if (typeof globalThis.WritableStream === "undefined") Object.assign(globalThis, { WritableStream });

if (typeof AbortSignal.prototype.throwIfAborted === "undefined") {
  Object.defineProperty(AbortSignal.prototype, "throwIfAborted", {
    configurable: true,
    writable: true,
    value(this: AbortSignal): void {
      if (!this.aborted) return;
      if (this.reason !== undefined) throw this.reason;
      const error = new Error("The operation was aborted.");
      error.name = "AbortError";
      throw error;
    },
  });
}

// LangChain expects a string when navigator exists. This is runtime detection,
// not caller-supplied trust or framework attribution in the native protocol.
if (typeof navigator !== "undefined" && typeof navigator.userAgent !== "string") {
  Object.defineProperty(navigator, "userAgent", { value: "ReactNative/0.82", configurable: true });
}

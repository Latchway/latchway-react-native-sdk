// App-owned LangChain compatibility for RN 0.82, not native authentication.
// Import first in index.js. Reuse existing compatible globals; never patch fetch.
import './symbols';
import 'react-native-get-random-values';
import {
  URL as CompatibleURL,
  URLSearchParams as CompatibleURLSearchParams,
} from 'react-native-url-polyfill';
import {ReadableStream, TransformStream, WritableStream} from 'web-streams-polyfill';
import {TextDecoder, TextEncoder} from 'text-encoding';

function hasWorkingURL(): boolean {
  try {
    const url = new globalThis.URL('child?q=hello%20world', 'https://example.invalid/root/');
    // RN's partial URL passes query parsing but adds '/' to absolute API paths.
    // Reading searchParams must not change serialization either.
    return ['/v1/responses', '/v1/chat/completions'].every(path => {
      const route = new globalThis.URL(`https://example.invalid${path}`);
      return route.href === `https://example.invalid${path}` && route.pathname === path;
    }) &&
      url.searchParams.get('q') === 'hello world' &&
      url.href === 'https://example.invalid/root/child?q=hello%20world' &&
      new globalThis.URLSearchParams({q: 'hello world'}).get('q') === 'hello world';
  } catch {
    return false;
  }
}

if (!hasWorkingURL()) Object.assign(globalThis, {URL: CompatibleURL, URLSearchParams: CompatibleURLSearchParams});
if (typeof globalThis.TextEncoder === 'undefined') Object.assign(globalThis, {TextEncoder});
if (typeof globalThis.TextDecoder === 'undefined') Object.assign(globalThis, {TextDecoder});
if (typeof globalThis.ReadableStream === 'undefined') Object.assign(globalThis, {ReadableStream});
if (typeof globalThis.TransformStream === 'undefined') Object.assign(globalThis, {TransformStream});
if (typeof globalThis.WritableStream === 'undefined') Object.assign(globalThis, {WritableStream});

if (typeof AbortSignal.prototype.throwIfAborted === 'undefined') {
  Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', {
    configurable: true,
    writable: true,
    value(this: AbortSignal): void {
      if (!this.aborted) return;
      if (this.reason !== undefined) throw this.reason;
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    },
  });
}

if (typeof navigator !== 'undefined' && typeof navigator.userAgent !== 'string') {
  Object.defineProperty(navigator, 'userAgent', {value: 'ReactNative/0.82', configurable: true});
}

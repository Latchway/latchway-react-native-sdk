import { createRequire } from "node:module";
import {
  ReadableStream as PonyfillReadableStream,
  TransformStream as PonyfillTransformStream,
  WritableStream as PonyfillWritableStream,
} from "web-streams-polyfill";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { responseWithNativeBody } from "../src/response.js";

const require = createRequire(import.meta.url);
const { Response: ReactNativeResponse } = require("whatwg-fetch") as { Response: typeof Response };
const UTF8 = new TextEncoder();
const UNICODE_TEXT = "Xin chào 🌤️ — 東京 / café";
const REQUEST_ID = "req_response_body_fixture";
const HostReadableStream = globalThis.ReadableStream;
const HostTransformStream = globalThis.TransformStream;
const HostWritableStream = globalThis.WritableStream;

beforeEach(() => {
  vi.stubGlobal("Response", ReactNativeResponse);
  vi.stubGlobal("ReadableStream", PonyfillReadableStream);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("React Native Response body compatibility", () => {
  it("reads exact UTF-8 text when every multibyte code point spans native chunks", async () => {
    const response = makeResponse(UNICODE_TEXT);

    expect(response).toBeInstanceOf(ReactNativeResponse);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe(UNICODE_TEXT);
    expect(response.bodyUsed).toBe(true);
  });

  it("parses successful JSON from the native stream rather than its object description", async () => {
    const payload = { message: UNICODE_TEXT, values: [true, null, 7] };
    const response = makeResponse(JSON.stringify(payload), "application/json");

    expect(await response.json()).toEqual(payload);
    expect(response.bodyUsed).toBe(true);
  });

  it("preserves structured HTTP error bodies", async () => {
    const payload = { error: { code: "quota_exceeded", message: "Daily allowance reached." } };
    const response = makeResponse(JSON.stringify(payload), "application/json", 429);

    expect(response.ok).toBe(false);
    expect(await response.json()).toEqual(payload);
  });

  it("does not invent a content type from the stream object, including on a clone", async () => {
    const response = responseWithNativeBody(byteStream(UTF8.encode("body")), {
      status: 200, headers: { "x-request-id": REQUEST_ID },
    });
    const clone = response.clone();

    expect(response.headers.get("content-type")).toBeNull();
    expect(clone.headers.get("content-type")).toBeNull();
    expect(clone.headers.get("x-request-id")).toBe(REQUEST_ID);
    await expect(Promise.all([response.text(), clone.text()])).resolves.toEqual(["body", "body"]);
  });

  it("reads arrayBuffer bytes without re-encoding binary data", async () => {
    const expected = new Uint8Array([0, 255, 128, 1, 13, 10]);
    const response = responseWithNativeBody(byteStream(expected), { status: 200 });

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    expect(response.bodyUsed).toBe(true);
  });

  it("ignores a UTF-8 BOM even when it spans chunks", async () => {
    const response = responseWithNativeBody(byteStream(new Uint8Array([
      0xef, 0xbb, 0xbf, ...UTF8.encode(UNICODE_TEXT),
    ])), { status: 200 });

    await expect(response.text()).resolves.toBe(UNICODE_TEXT);
  });

  it("decodes malformed UTF-8 with replacement characters", async () => {
    const response = responseWithNativeBody(byteStream(new Uint8Array([
      0x61, 0xc3, 0x28, 0xff, 0x62,
    ])), { status: 200 });

    await expect(response.text()).resolves.toBe("a\uFFFD(\uFFFDb");
  });

  it("reads only the supplied byte view, excluding its backing buffer prefix and suffix", async () => {
    const backing = new Uint8Array([255, 0, 104, 105, 0, 255]);
    const source = new PonyfillReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(backing.subarray(2, 4));
        controller.close();
      },
    });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, { status: 200 });

    await expect(response.text()).resolves.toBe("hi");
  });

  it("reads a Blob with the response content type", async () => {
    const response = makeResponse(UNICODE_TEXT, "text/plain;charset=utf-8");
    const blob = await response.blob();

    expect(blob.type).toBe("text/plain;charset=utf-8");
    expect(await blob.text()).toBe(UNICODE_TEXT);
    expect(response.bodyUsed).toBe(true);
  });

  it("reads URL-encoded form data with duplicate fields and Unicode", async () => {
    const response = makeResponse(
      "city=%E6%9D%B1%E4%BA%AC&city=caf%C3%A9&greeting=Xin+ch%C3%A0o",
      "application/x-www-form-urlencoded;charset=utf-8",
    );
    const form = await response.formData();

    expect(form.getAll("city")).toEqual(["東京", "café"]);
    expect(form.getAll("greeting")).toEqual(["Xin chào"]);
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it("consumes and rejects unsupported multipart form data explicitly", async () => {
    const response = makeResponse("--fixture--\r\n", "multipart/form-data;boundary=fixture");

    await expect(response.formData()).rejects.toBeInstanceOf(TypeError);
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it.each(["text", "json", "arrayBuffer", "blob"] as const)(
    "rejects %s after another body reader consumed the response", async (method) => {
      const response = makeResponse('{"ok":true}', "application/json");
      await response.text();

      await expect(response[method]()).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("rejects simultaneous body readers", async () => {
    const response = makeResponse('{"ok":true}', "application/json");
    const first = response.text();

    await expect(response.json()).rejects.toBeInstanceOf(TypeError);
    await expect(first).resolves.toBe('{"ok":true}');
  });

  it("distinguishes a locked stream from a consumed stream", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const reader = requireBody(response).getReader();

    expect(response.bodyUsed).toBe(false);
    expect(response.body?.locked).toBe(true);
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
    expect(response.bodyUsed).toBe(false);
    reader.releaseLock();
    await expect(response.text()).resolves.toBe(UNICODE_TEXT);
  });

  it("marks direct reader consumption and rejects reading only the remaining bytes as text", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const reader = requireBody(response).getReader();

    const pending = reader.read();
    expect(response.bodyUsed).toBe(true);
    await pending;
    reader.releaseLock();
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
    expect(() => response.clone()).toThrow(TypeError);
  });

  it("streams all bytes directly without changing UTF-8 content", async () => {
    const response = makeResponse(UNICODE_TEXT, "text/event-stream");
    const reader = requireBody(response).getReader();
    const received: number[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      received.push(...result.value);
    }
    reader.releaseLock();

    expect(new Uint8Array(received)).toEqual(UTF8.encode(UNICODE_TEXT));
    expect(response.bodyUsed).toBe(true);
  });

  it("does not eagerly pull or buffer an SSE body", async () => {
    const pull = vi.fn((controller: { enqueue: (chunk: Uint8Array) => void }) => {
      controller.enqueue(UTF8.encode("data: first\n\n"));
    });
    const source = new PonyfillReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, {
      status: 200, headers: { "content-type": "text/event-stream" },
    });
    await Promise.resolve();
    expect(pull).not.toHaveBeenCalled();
    const reader = requireBody(response).getReader();
    await Promise.resolve();
    expect(pull).not.toHaveBeenCalled();
    await reader.read();
    expect(pull).toHaveBeenCalledOnce();
    await reader.cancel();
    reader.releaseLock();
  });

  it("tracks pipeTo consumption immediately and preserves all bytes", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const received: number[] = [];
    const sink = new PonyfillWritableStream<Uint8Array>({
      write(chunk) { received.push(...chunk); },
    });
    const pending = requireBody(response).pipeTo(sink);

    expect(response.bodyUsed).toBe(true);
    await pending;
    expect(new Uint8Array(received)).toEqual(UTF8.encode(UNICODE_TEXT));
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it("tracks pipeThrough consumption and preserves transformed stream ownership", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const transform = new PonyfillTransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) { controller.enqueue(chunk); },
    });
    const transformed = requireBody(response).pipeThrough(
      transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );

    expect(response.bodyUsed).toBe(true);
    const received: number[] = [];
    for await (const chunk of transformed) received.push(...chunk);
    expect(new Uint8Array(received)).toEqual(UTF8.encode(UNICODE_TEXT));
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it("tracks async iterator consumption before its first read resolves", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const iterator = requireBody(response)[Symbol.asyncIterator]();

    expect(response.bodyUsed).toBe(false);
    const pending = iterator.next();
    expect(response.bodyUsed).toBe(true);
    expect((await pending).done).toBe(false);
    await iterator.return?.();
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it("keeps an unread body available after closing an iterator with preventCancel", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const iterator = requireBody(response).values({ preventCancel: true });

    await iterator.return?.();
    expect(response.bodyUsed).toBe(false);
    expect(response.body?.locked).toBe(false);
    await expect(response.text()).resolves.toBe(UNICODE_TEXT);
  });

  it("does not mark the body consumed when next is called on an already closed iterator", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const iterator = requireBody(response).values({ preventCancel: true });
    await iterator.return?.();

    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    expect(response.bodyUsed).toBe(false);
    await expect(response.text()).resolves.toBe(UNICODE_TEXT);
  });

  it("interoperates with native host transforms and writable streams", async () => {
    vi.stubGlobal("ReadableStream", HostReadableStream);
    const response = makeResponse(UNICODE_TEXT);
    const transformed = requireBody(response).pipeThrough(new HostTransformStream<Uint8Array, Uint8Array>());
    const received: number[] = [];
    await transformed.pipeTo(new HostWritableStream<Uint8Array>({
      write(chunk) { received.push(...chunk); },
    }));

    expect(new Uint8Array(received)).toEqual(UTF8.encode(UNICODE_TEXT));
    expect(response.bodyUsed).toBe(true);
  });

  it("falls back to ponyfill streams when the host has no ReadableStream", async () => {
    vi.stubGlobal("ReadableStream", undefined);
    const response = makeResponse(UNICODE_TEXT);
    const transformed = requireBody(response).pipeThrough(
      new PonyfillTransformStream<Uint8Array, Uint8Array>() as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
    const received: number[] = [];
    await transformed.pipeTo(new PonyfillWritableStream<Uint8Array>({
      write(chunk) { received.push(...chunk); },
    }));

    expect(new Uint8Array(received)).toEqual(UTF8.encode(UNICODE_TEXT));
    expect(response.bodyUsed).toBe(true);
  });

  it.each(["native", "absent"] as const)("propagates source failure with the %s host stream mode", async (mode) => {
    vi.stubGlobal("ReadableStream", mode === "native" ? HostReadableStream : undefined);
    const failure = new Error("native read failed");
    const source = new PonyfillReadableStream<Uint8Array>({
      pull(controller) { controller.error(failure); },
    }, { highWaterMark: 0 });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, { status: 200 });

    await expect(response.text()).rejects.toBe(failure);
    expect(response.bodyUsed).toBe(true);
  });

  it.each(["native", "absent"] as const)("cancels a pending read with the %s host stream mode", async (mode) => {
    vi.stubGlobal("ReadableStream", mode === "native" ? HostReadableStream : undefined);
    const cancel = vi.fn();
    const source = new PonyfillReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, { status: 200 });
    const reader = requireBody(response).getReader();
    const pending = reader.read();
    await Promise.resolve();
    await reader.cancel("request aborted");

    await expect(pending).resolves.toMatchObject({ done: true });
    expect(cancel).toHaveBeenCalledExactlyOnceWith("request aborted");
    expect(response.bodyUsed).toBe(true);
    reader.releaseLock();
  });

  it("clones an unread native stream into independently consumable responses", async () => {
    const response = makeResponse(UNICODE_TEXT);
    const clone = response.clone();
    clone.headers.set("x-request-id", "clone-only");

    expect(response.bodyUsed).toBe(false);
    expect(clone.bodyUsed).toBe(false);
    expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(clone.status).toBe(200);
    await expect(Promise.all([response.text(), clone.text()])).resolves.toEqual([
      UNICODE_TEXT, UNICODE_TEXT,
    ]);
    expect(response.bodyUsed).toBe(true);
    expect(clone.bodyUsed).toBe(true);
  });

  it("rejects cloning a locked response before any bytes are read", () => {
    const response = makeResponse("body");
    const reader = requireBody(response).getReader();

    expect(() => response.clone()).toThrow(TypeError);
    reader.releaseLock();
  });

  it("propagates direct body cancellation to the native-owned source once", async () => {
    const cancel = vi.fn();
    const source = new PonyfillReadableStream<Uint8Array>({ cancel });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, { status: 200 });

    await requireBody(response).cancel("screen closed");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("screen closed");
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it("propagates reader cancellation to the native-owned source", async () => {
    const cancel = vi.fn();
    const source = new PonyfillReadableStream<Uint8Array>({ cancel });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, { status: 200 });
    const reader = requireBody(response).getReader();

    await reader.cancel("account changed");
    reader.releaseLock();
    expect(cancel).toHaveBeenCalledExactlyOnceWith("account changed");
    expect(response.bodyUsed).toBe(true);
  });

  it("does not cancel the source when only one clone branch is canceled", async () => {
    const cancel = vi.fn();
    const source = new PonyfillReadableStream<Uint8Array>({ cancel });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, { status: 200 });
    const clone = response.clone();
    const first = requireBody(response).cancel("original closed");

    expect(cancel).not.toHaveBeenCalled();
    const second = requireBody(clone).cancel("clone closed");
    await Promise.all([first, second]);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(["original closed", "clone closed"]);
  });

  it("preserves a stream failure rather than replacing it with a JSON parsing error", async () => {
    const failure = new Error("native response interrupted");
    const source = new PonyfillReadableStream<Uint8Array>({
      start(controller) { controller.error(failure); },
    });
    const response = responseWithNativeBody(source as unknown as ReadableStream<Uint8Array>, { status: 200 });

    await expect(response.text()).rejects.toBe(failure);
    expect(response.bodyUsed).toBe(true);
  });

  it("keeps null-body responses readable without marking them consumed", async () => {
    const response = responseWithNativeBody(null, { status: 204 });

    expect(response.body ?? null).toBeNull();
    await expect(response.text()).resolves.toBe("");
    await expect(response.text()).resolves.toBe("");
    expect(response.bodyUsed).toBe(false);
    expect(response.clone().status).toBe(204);
  });
});

function makeResponse(text: string, contentType = "text/plain", status = 200): Response {
  return responseWithNativeBody(byteStream(UTF8.encode(text)), {
    status,
    headers: { "content-type": contentType, "x-request-id": REQUEST_ID },
  });
}

function byteStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new PonyfillReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, ++offset));
    },
  }) as unknown as ReadableStream<Uint8Array>;
}

function requireBody(response: Response): ReadableStream<Uint8Array> {
  if (response.body === null) throw new Error("missing native response body");
  return response.body;
}

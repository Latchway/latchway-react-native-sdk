import { ReadableStream as PonyfillReadableStream } from "web-streams-polyfill";

/** Keep standards-compliant hosts untouched; adapt only RN's stream-blind Body. */
export function responseWithNativeBody(body: ReadableStream<Uint8Array> | null, init: ResponseInit): Response {
  let response: Response;
  try {
    response = new Response(body, init);
  } catch {
    response = new Response(null, init);
  }
  const exposed = (response as Response & { body?: ReadableStream<Uint8Array> | null }).body;
  if (body === null ? exposed === null : exposed != null && typeof exposed.getReader === "function") {
    return response;
  }
  // Discard the stream-blind host's stringified body and any Content-Type it
  // inferred from that string. Native response headers remain authoritative.
  return attachBody(new Response(null, init), body);
}

interface BodyState {
  stream: ReadableStream<Uint8Array>;
  used: boolean;
}

function attachBody(response: Response, source: ReadableStream<Uint8Array> | null): Response {
  let state = source === null ? null : trackBody(source);
  const assertUnused = (): void => {
    if (state !== null && (state.used || state.stream.locked)) {
      throw new TypeError("Response body is already used or locked.");
    }
  };
  const bytes = async (): Promise<Uint8Array<ArrayBuffer>> => {
    assertUnused();
    if (state === null) return new Uint8Array(0);
    const reader = state.stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new TypeError("Response body must contain bytes.");
        chunks.push(value);
        length += value.byteLength;
      }
    } catch (error) {
      await reader.cancel(error).catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  };
  const text = async (): Promise<string> => new TextDecoder().decode(await bytes());

  Object.defineProperties(response, {
    body: { configurable: true, enumerable: true, get: () => state?.stream ?? null },
    bodyUsed: { configurable: true, enumerable: true, get: () => state?.used ?? false },
    bytes: { configurable: true, value: bytes },
    arrayBuffer: { configurable: true, value: async () => (await bytes()).buffer },
    text: { configurable: true, value: text },
    json: { configurable: true, value: async (): Promise<unknown> => JSON.parse(await text()) as unknown },
    // Blob binary-part support belongs to the host. Never decode arbitrary
    // bytes as text to work around an unsupported React Native Blob feature.
    blob: { configurable: true, value: async () => new Blob([await bytes()], {
      type: response.headers.get("content-type") ?? "",
    }) },
    formData: { configurable: true, value: async () => {
      const content = await text();
      const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (type !== "application/x-www-form-urlencoded") {
        throw new TypeError("This React Native response supports only URL-encoded form data.");
      }
      const form = new FormData();
      new URLSearchParams(content).forEach((value, key) => { form.append(key, value); });
      return form;
    } },
    clone: { configurable: true, value: () => {
      assertUnused();
      let copy: ReadableStream<Uint8Array> | null = null;
      if (state !== null) {
        const branches = state.stream.tee();
        state = trackBody(branches[0]);
        copy = branches[1];
      }
      // Copy current headers, including the framework request-ID alias added
      // by the caller. Branches have independent consumption/locking state.
      return attachBody(new Response(null, {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
      }), copy);
    } },
  });
  return response;
}

/**
 * The streams library owns queueing, locks, teeing and cancellation. Track only
 * Fetch's disturbed flag, which the public Streams API does not expose.
 */
function trackBody(source: ReadableStream<Uint8Array>): BodyState {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const release = (): void => { reader?.releaseLock(); reader = undefined; };
  // Match nativeResponseBody's stream implementation, so host transforms and
  // writable streams remain interoperable when global Web Streams exist.
  const Stream = typeof globalThis.ReadableStream === "function"
    ? globalThis.ReadableStream
    : PonyfillReadableStream as unknown as typeof globalThis.ReadableStream;
  const state: BodyState = { used: false, stream: new Stream<Uint8Array>({
    async pull(controller) {
      state.used = true;
      reader ??= source.getReader();
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          release();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        release();
      }
    },
    async cancel(reason) {
      state.used = true;
      try {
        if (reader === undefined) await source.cancel(reason);
        else await reader.cancel(reason);
      } finally {
        release();
      }
    },
  }, { highWaterMark: 0 }) };
  const stream = state.stream;
  const getReader = stream.getReader.bind(stream);
  const cancel = stream.cancel.bind(stream);
  const tee = stream.tee.bind(stream);
  const pipeTo = stream.pipeTo.bind(stream);
  const pipeThrough = stream.pipeThrough.bind(stream);
  const values = stream.values?.bind(stream) ?? stream[Symbol.asyncIterator]?.bind(stream);
  const trackedValues = (options?: ReadableStreamIteratorOptions): ReadableStreamAsyncIterator<Uint8Array> => {
    if (values === undefined) throw new TypeError("This host does not support stream iteration.");
    const iterator = values(options);
    const next = iterator.next.bind(iterator);
    const finish = iterator.return?.bind(iterator);
    let active = true;
    iterator.next = (...args) => { if (active) state.used = true; return next(...args); };
    if (finish !== undefined) {
      iterator.return = (...args) => {
        if (active && options?.preventCancel !== true) state.used = true;
        active = false;
        return finish(...args);
      };
    }
    return iterator;
  };
  Object.defineProperties(stream, {
    getReader: { configurable: true, value: (options?: ReadableStreamGetReaderOptions) => {
      const consumer = getReader(options) as ReadableStreamDefaultReader<Uint8Array>;
      const read = consumer.read.bind(consumer);
      const cancelRead = consumer.cancel.bind(consumer);
      const releaseLock = consumer.releaseLock.bind(consumer);
      let active = true;
      consumer.read = () => { if (active) state.used = true; return read(); };
      consumer.cancel = (reason) => { if (active) state.used = true; return cancelRead(reason); };
      consumer.releaseLock = () => { releaseLock(); active = false; };
      return consumer;
    } },
    cancel: { configurable: true, value: (reason?: unknown) => {
      if (!stream.locked) state.used = true;
      return cancel(reason);
    } },
    tee: { configurable: true, value: () => {
      const result = tee();
      state.used = true;
      return result;
    } },
    pipeTo: { configurable: true, value: (destination: WritableStream<Uint8Array>, options?: StreamPipeOptions) => {
      const locked = stream.locked;
      const result = pipeTo(destination, options);
      if (!locked && stream.locked) state.used = true;
      return result;
    } },
    pipeThrough: { configurable: true, value: <T>(transform: ReadableWritablePair<T, Uint8Array>, options?: StreamPipeOptions) => {
      const result = pipeThrough(transform, options);
      state.used = true;
      return result;
    } },
    ...(values === undefined ? {} : {
      values: { configurable: true, value: trackedValues },
      [Symbol.asyncIterator]: { configurable: true, value: trackedValues },
    }),
  });
  return state;
}

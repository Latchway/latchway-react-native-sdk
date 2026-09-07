import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { withLatchwayBabel } = require("../babel.cjs");
const compile = (name) => ts.transpileModule(
  readFileSync(new URL(`../src/${name}.ts`, import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const evaluate = (code, context) => runInNewContext(`(function () { ${code}\n })();`, context);

// Isolated VM fixtures model missing Hermes globals; no native security mock
// participates in production. Symbol must initialize before stream evaluation.
function runtime(existing = {}) {
  class Signal { aborted = false; }
  const context = {
    exports: {}, Symbol: { for: Symbol.for }, navigator: {}, AbortSignal: Signal,
    ...existing,
  };
  context.require = (name) => {
    if (name === "./runtime-symbols.js") {
      evaluate(compile("runtime-symbols"), context);
      return {};
    }
    if (name === "react-native-get-random-values") return {};
    if (name === "react-native-url-polyfill") return { URL, URLSearchParams };
    if (name === "web-streams-polyfill") {
      assert.equal(typeof context.Symbol.asyncIterator, "symbol", "bootstrap must precede stream imports");
      return require(name);
    }
    if (name === "text-encoding") return require(name);
    throw new Error(`Unexpected fixture import: ${name}`);
  };
  evaluate(compile("polyfills"), context);
  return context;
}

test("one explicit entry installs missing globals and stable async symbols", () => {
  const env = runtime();
  assert.equal(env.Symbol.asyncIterator, Symbol.for("Symbol.asyncIterator"));
  assert.equal(env.Symbol.asyncDispose, Symbol.for("Symbol.asyncDispose"));
  assert.equal(env.navigator.userAgent, "ReactNative/0.82");
  for (const name of ["ReadableStream", "WritableStream", "TransformStream", "TextDecoder", "TextEncoder"]) {
    assert.equal(typeof env[name], "function");
  }
  const symbol = env.Symbol.asyncIterator;
  evaluate(compile("polyfills"), env);
  assert.equal(env.Symbol.asyncIterator, symbol);
});

test("retains complete application globals and does not touch fetch or native secrets", () => {
  const existing = { Symbol, URL, URLSearchParams, TextEncoder, TextDecoder,
    ReadableStream, WritableStream, TransformStream, AbortSignal,
    navigator: { userAgent: "ExistingRuntime" }, fetch: () => {}, crypto: { sentinel: "unchanged" } };
  const env = runtime(existing);
  for (const [key, value] of Object.entries(existing)) assert.equal(env[key], value, key);
});

test("replaces incomplete URL implementations only", () => {
  const env = runtime({ URL: function IncompleteURL() { throw new Error("Not implemented"); } });
  assert.equal(new env.URL("/chat", "https://example.invalid").pathname, "/chat");
});

test("UTF-8 decoding buffers a split multi-byte character across stream chunks", () => {
  const env = runtime();
  const decoder = new env.TextDecoder();
  const bytes = new env.TextEncoder().encode("Hello 🌦 Việt Nam");
  const text = decoder.decode(bytes.subarray(0, 8), { stream: true }) +
    decoder.decode(bytes.subarray(8, 14), { stream: true }) +
    decoder.decode(bytes.subarray(14), { stream: true }) + decoder.decode();
  assert.equal(text, "Hello 🌦 Việt Nam");
});

test("AbortSignal compatibility preserves the original abort reason", () => {
  const env = runtime();
  const signal = new env.AbortSignal();
  signal.throwIfAborted();
  signal.aborted = true;
  signal.reason = new Error("Explicit cancellation");
  assert.throws(() => signal.throwIfAborted(), (error) => error === signal.reason);
  delete signal.reason;
  assert.throws(() => signal.throwIfAborted(), { name: "AbortError" });
});

test("Babel helper composes without mutating config or duplicating its plugin", () => {
  const input = { presets: ["module:@react-native/babel-preset"],
    assumptions: { setPublicClassFields: true }, plugins: ["caller-plugin"] };
  const output = withLatchwayBabel(input);
  assert.equal(output.assumptions.noClassCalls, true);
  assert.equal(output.assumptions.setPublicClassFields, true);
  assert.deepEqual(input.plugins, ["caller-plugin"]);
  assert.deepEqual(withLatchwayBabel(output), output);
  assert.throws(() => withLatchwayBabel({ assumptions: { noClassCalls: false } }), /conflicting/);
});

test("package exports real built files and marks only explicit bootstrap as side-effectful", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["."]["react-native"], "./lib/index.js");
  assert.deepEqual(pkg.sideEffects, ["./lib/polyfills.js", "./lib/runtime-symbols.js"]);
  assert.equal(pkg.dependencies["@langchain/openai"], undefined);
  assert(!readFileSync(new URL("../src/index.ts", import.meta.url), "utf8").includes("polyfills"));
});

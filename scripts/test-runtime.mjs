import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
const { withLatchwayBabel } = require("../babel.cjs");
const compile = (name) => ts.transpileModule(
  readFileSync(new URL(name.startsWith("../") ? `${name}.ts` : `../src/${name}.ts`, import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const evaluate = (code, context) => runInNewContext(`(function () { ${code}\n })();`, context);

test("lazy enforcing lookup escapes Metro's swallowed module-factory error without fallback", () => {
  const original = new Error("fixture-native-registration-failed");
  const fatal = [];
  let lookups = 0;
  let result;
  const context = {
    __DEV__: false, __METRO_GLOBAL_PREFIX__: "", console,
    ErrorUtils: {reportFatalError: error => fatal.push(error)},
    registry: {getEnforcing: name => {
      assert.equal(name, "NativeLatchway");
      lookups++;
      if (result === undefined) throw original;
      return result;
    }},
  };
  const metro = readFileSync(require.resolve("metro-runtime/src/polyfills/require.js"), "utf8");
  const spec = compile("native/NativeLatchway");
  const resolver = compile("native/resolve-native-module");
  const run = code => runInNewContext(code, context);
  run(`global = globalThis; ${metro}
    __d(function(global, r, id, ia, module) {
      module.exports = {TurboModuleRegistry: global.registry};
    }, 42, []);
    __d(function(global, r, id, ia, module, exports) {
      const require = name => { if (name !== "react-native") throw new Error("Unexpected import"); return r(42); };
      ${spec}
    }, 1, []);
    __d(function(global, r, id, ia, module, exports) {
      const require = name => { if (name !== "react-native") throw new Error("Unexpected import"); return r(42); };
      ${resolver}
    }, 2, []);`);
  assert.equal(run("__r.importAll(1).default"), undefined);
  assert.deepEqual(fatal, [original]);
  assert.equal(lookups, 1);
  const loaded = run("__r.importAll(2)");
  assert.equal(lookups, 1, "resolver import must not construct a native module");
  assert.throws(() => loaded.resolveNativeModule(), error => error === original);
  assert.equal(lookups, 2);
  assert.equal(fatal.length, 1, "lookup error reaches the caller, not Metro ErrorUtils");
  result = {configure() {}};
  assert.equal(loaded.resolveNativeModule(), result);
  assert.equal(lookups, 3, "a new explicit lookup is possible without retry/fallback");
});

// Isolated VM fixtures model missing Hermes globals; no native security mock
// participates in production. Symbol must initialize before stream evaluation.
function runtime(existing = {}, appOwned = false) {
  class Signal { aborted = false; }
  const context = {
    exports: {}, Symbol: { for: Symbol.for }, navigator: {}, AbortSignal: Signal,
    ...existing,
  };
  context.require = (name) => {
    if (name === "./runtime-symbols.js" || name === "./symbols") {
      evaluate(compile(appOwned ? "../Examples/LatchwayChat/src/runtime/symbols" : "runtime-symbols"), context);
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
  evaluate(compile(appOwned ? "../Examples/LatchwayChat/src/runtime/polyfills" : "polyfills"), context);
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

test("both bootstraps repair the actual RN partial URL without widening destination guards", () => {
  const babel = require("@babel/core");
  function rnURL(name) {
    const filename = new URL(`../node_modules/react-native/Libraries/Blob/${name}.js`, import.meta.url);
    const code = babel.transformSync(readFileSync(filename, "utf8"), {
      filename: filename.pathname, configFile: false, babelrc: false,
      presets: [require.resolve("@react-native/babel-preset")],
    }).code;
    const module = { exports: {} };
    const globals = name === "URL" ? { URLSearchParams: rnURL("URLSearchParams").URLSearchParams } : {};
    runInNewContext(`(function(require,module,exports){${code}\n})`, globals)(
      (id) => id === "./NativeBlobModule" ? { __esModule: true, default: null } :
        id === "./URLSearchParams" ? rnURL("URLSearchParams") : require(id),
      module, module.exports,
    );
    return module.exports;
  }
  const native = rnURL("URL");
  const paths = ["/v1/responses", "/v1/chat/completions"];
  for (const path of paths) {
    assert.equal(new native.URL(`https://example.invalid${path}`).pathname, `${path}/`);
  }
  for (const appOwned of [false, true]) {
    const fetch = () => {};
    const env = runtime({ ...native, fetch }, appOwned);
    assert.equal(env.URL, URL);
    assert.equal(env.fetch, fetch);
    for (const path of paths) {
      const route = new env.URL(`https://example.invalid${path}`);
      assert.equal(route.pathname, path);
      assert.equal(route.href, `https://example.invalid${path}`);
    }
    const complete = runtime({ URL, URLSearchParams, fetch }, appOwned);
    assert.equal(complete.URL, URL);
    assert.equal(complete.URLSearchParams, URLSearchParams);
    assert.equal(complete.fetch, fetch);
  }
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

test("core dependencies stay small and legacy convenience peers are not auto-installed", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@latchway/client", "web-streams-polyfill"]);
  for (const name of ["@babel/plugin-transform-export-namespace-from", "react-native-get-random-values",
    "react-native-url-polyfill", "text-encoding"]) {
    assert.equal(pkg.dependencies[name], undefined);
    assert.equal(pkg.optionalDependencies?.[name], undefined);
    assert.equal(pkg.peerDependenciesMeta[name].optional, true);
    assert(pkg.peerDependencies[name]);
    assert(pkg.devDependencies[name], "legacy helpers remain tested with exact dev pins");
  }
});

test("legacy Babel helper explains the missing app-owned plugin", () => {
  const source = readFileSync(new URL("../babel.cjs", import.meta.url), "utf8");
  const context = { module: { exports: {} }, require: { resolve() { throw new Error("MODULE_NOT_FOUND"); } } };
  evaluate(source, context);
  assert.throws(() => context.module.exports.withLatchwayBabel(), /npm install --save-dev/);
});

test("app-owned runtime preserves globals, symbol ordering, split UTF-8 and cancellation", () => {
  const existing = { URL, URLSearchParams, navigator: { userAgent: "HostApp" }, fetch: () => {} };
  const env = runtime(existing, true);
  for (const [key, value] of Object.entries(existing)) assert.equal(env[key], value, key);
  const decoder = new env.TextDecoder();
  const bytes = new env.TextEncoder().encode("Hello 🌦 Việt Nam");
  assert.equal(decoder.decode(bytes.subarray(0, 8), { stream: true }) +
    decoder.decode(bytes.subarray(8), { stream: true }) + decoder.decode(), "Hello 🌦 Việt Nam");
  const signal = new env.AbortSignal();
  signal.throwIfAborted();
  signal.aborted = true;
  signal.reason = new Error("Host cancellation");
  assert.throws(() => signal.throwIfAborted(), (error) => error === signal.reason);
  assert.equal(runtime({ URL: function IncompleteURL() { throw new Error("Not implemented"); } }, true).URL, URL);
});

test("example owns integration dependencies and does not import deprecated helpers", () => {
  const root = new URL("../Examples/LatchwayChat/", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  for (const name of ["react-native-get-random-values", "react-native-url-polyfill", "text-encoding", "web-streams-polyfill"]) {
    assert(pkg.dependencies[name], name);
  }
  assert(pkg.devDependencies["@babel/plugin-transform-export-namespace-from"]);
  const entry = readFileSync(new URL("index.js", root), "utf8");
  assert(entry.includes("import './src/runtime/polyfills'"));
  assert(!entry.includes("@latchway/react-native/polyfills"));
  assert(!readFileSync(new URL("babel.config.js", root), "utf8").includes("@latchway/react-native/babel"));
});

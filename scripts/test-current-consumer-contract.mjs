import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {CURRENT_BRIDGE_METHODS, assertCurrentNativeSpec, assertCurrentNativeSchema} from "./current-consumer-contract.mjs";

const source = await readFile(new URL("../src/native/NativeLatchway.ts", import.meta.url), "utf8");
const methods = () => CURRENT_BRIDGE_METHODS.map(name => ({name, typeAnnotation: {params: []}}));
const schema = (values, key = "methods") => ({modules: {NativeLatchway: {spec: {[key]: values}}}});

test("current native source has exactly the 17 tokenless methods", () => {
  assert.doesNotThrow(() => assertCurrentNativeSpec(source));
  assert.throws(() => assertCurrentNativeSpec(source.replace("  appCommand(", "  configure(")));
  assert.throws(() => assertCurrentNativeSpec(source.replace("    requestJSON: string,", "    identityToken: string,\n    requestJSON: string,")));
});

test("both current and minimum Codegen schema layouts enforce the exact method set", () => {
  for (const layout of ["methods", "properties"]) {
    assert.doesNotThrow(() => assertCurrentNativeSchema(schema(methods(), layout)));
    assert.throws(() => assertCurrentNativeSchema(schema([...methods(), {name: "configure"}], layout)));
    assert.throws(() => assertCurrentNativeSchema(schema(methods().slice(1), layout)));
  }
});

test("generated token parameters and duplicate/unknown native methods fail closed", () => {
  const values = methods();
  values[2].typeAnnotation.params.push({name: "identityToken"});
  assert.throws(() => assertCurrentNativeSchema(schema(values)));
  const duplicate = methods();
  duplicate[0].name = duplicate[1].name;
  assert.throws(() => assertCurrentNativeSchema(schema(duplicate)));
  assert.throws(() => assertCurrentNativeSchema({}));
});

test("registry iOS builds are supported and require an actual archive before creating a host", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-minimum-host.mjs", "--ios", "--tarball", "/nonexistent-latchway-archive.tgz"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/u);
  assert.doesNotMatch(result.stderr, /require --shared-native-development/u);
  assert.doesNotMatch(result.stdout, /Minimum host:/u);
});

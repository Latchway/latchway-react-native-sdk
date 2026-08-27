import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const artifacts = new URL("../.artifacts/codegen/", import.meta.url);
const schema = new URL("schema.json", artifacts);
const generated = new URL("generated/", artifacts);
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
execFileSync(
  process.execPath,
  [
    "node_modules/@react-native/codegen/lib/cli/combine/combine-js-to-schema-cli.js",
    schema.pathname,
    "src/native",
  ],
  { cwd: root, stdio: "inherit" },
);
const parsed = JSON.parse(await readFile(schema, "utf8"));
if (parsed.modules?.NativeLatchway?.type !== "NativeModule") {
  throw new Error("React Native Codegen did not discover NativeLatchway.");
}
execFileSync(
  process.execPath,
  [
    "node_modules/@react-native/codegen/lib/cli/generators/generate-all.js",
    schema.pathname,
    "LatchwayReactNativeSpec",
    generated.pathname,
    "dev.latchway.reactnative",
    "true",
  ],
  { cwd: root, stdio: "inherit" },
);
for (const required of [
  "java/dev/latchway/reactnative/NativeLatchwaySpec.java",
  "LatchwayReactNativeSpec/LatchwayReactNativeSpec.h",
  "LatchwayReactNativeSpec/LatchwayReactNativeSpec-generated.mm",
]) {
  await readFile(new URL(required, generated));
}

import { readJSON } from "./release-metadata.mjs";

const lock = await readJSON("release-compatibility.json");
const outputs = {
  android_commit: lock.android.source_commit,
  android_compile_sdk: String(lock.android.compile_sdk),
  android_version: lock.android.version,
  contract_version: lock.contract.version,
  core_commit: lock.contract.core_commit,
  ios_commit: lock.ios.source_commit,
  ios_version: lock.ios.version,
  javascript_commit: lock.javascript.source_commit,
  javascript_version: lock.javascript.version,
  react_native_version: lock.react_native.version,
};

for (const [name, value] of Object.entries(outputs)) {
  if (typeof value !== "string" || !/^[0-9A-Za-z@./_-]+$/u.test(value)) {
    throw new Error(`Release compatibility output ${name} is unsafe.`);
  }
  process.stdout.write(`${name}=${value}\n`);
}

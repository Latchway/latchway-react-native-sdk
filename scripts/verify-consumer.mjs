import { execFileSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { assertEqual, readJSON } from "./release-metadata.mjs";
import {
  isolatedRegistryEnvironment,
  pnpmRegistryArguments,
  writeRegistryNpmrcs,
} from "./npm-registry-isolation.mjs";

const compatibility = await readJSON("release-compatibility.json");
const packageJSON = await readJSON("package.json");
const publishedMode = process.argv.includes("--published");
const reactNativeArchive = resolve(option("--react-native-tarball") ??
  `.artifacts/latchway-react-native-${packageJSON.version}.tgz`);
const defaultClientArchive = new URL(
  `../../latchway-js/.artifacts/latchway-client-${compatibility.javascript.version}.tgz`,
  import.meta.url,
).pathname;
const clientArchive = publishedMode ? undefined : resolve(option("--client-tarball") ?? defaultClientArchive);

if (!existsSync(reactNativeArchive)) {
  throw new Error(`React Native package archive does not exist: ${reactNativeArchive}. Run pnpm pack:check first.`);
}
if (clientArchive !== undefined && !existsSync(clientArchive)) {
  throw new Error(`JavaScript package archive does not exist: ${clientArchive}. Pack the locked JavaScript SDK first.`);
}

const temporary = await mkdtemp(join(tmpdir(), "latchway-rn-consumer-"));
try {
  await cp(new URL("../integration/consumer/", import.meta.url), temporary, { recursive: true });
  const userconfig = join(temporary, ".npmrc");
  const globalconfig = join(temporary, ".global.npmrc");
  writeRegistryNpmrcs(userconfig, globalconfig, ["fund=false"]);
  const packageManagerEnvironment = isolatedRegistryEnvironment(process.env, {
    cache: join(temporary, ".npm-cache"),
    excludedNames: ["NODE_AUTH_TOKEN", "NPM_TOKEN"],
    globalconfig,
    userconfig,
  });
  const manifestPath = join(temporary, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assertEqual(manifest.dependencies[compatibility.react_native.package], compatibility.react_native.version,
    "consumer React Native dependency lock");
  assertEqual(manifest.dependencies[compatibility.javascript.package], compatibility.javascript.version,
    "consumer JavaScript dependency lock");
  manifest.dependencies[compatibility.react_native.package] = `file:${reactNativeArchive}`;
  if (clientArchive !== undefined) {
    manifest.dependencies[compatibility.javascript.package] = `file:${clientArchive}`;
    manifest.pnpm = {
      overrides: { [compatibility.javascript.package]: `file:${clientArchive}` },
    };
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  runPackageManager(pnpmRegistryArguments([
    "install", "--ignore-scripts", "--lockfile=false", "--prefer-offline",
  ]), temporary, packageManagerEnvironment);
  runPackageManager(["exec", "tsc", "-p", "tsconfig.json"], temporary, packageManagerEnvironment);

  const installed = JSON.parse(await readFile(
    join(temporary, "node_modules", "@latchway", "react-native", "package.json"),
    "utf8",
  ));
  assertEqual(installed.name, compatibility.react_native.package, "installed consumer package name");
  assertEqual(installed.version, compatibility.react_native.version, "installed consumer package version");
  assertEqual(installed.dependencies?.[compatibility.javascript.package], compatibility.javascript.version,
    "installed consumer JavaScript dependency");
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a path.`);
  return value;
}

function runPackageManager(arguments_, cwd, environment) {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) throw new Error("Run consumer verification through pnpm.");
  if (/\.[cm]?js$/u.test(packageManager)) {
    execFileSync(process.execPath, [packageManager, ...arguments_], {
      cwd, env: environment, stdio: "inherit",
    });
  } else {
    execFileSync(packageManager, arguments_, { cwd, env: environment, stdio: "inherit" });
  }
}

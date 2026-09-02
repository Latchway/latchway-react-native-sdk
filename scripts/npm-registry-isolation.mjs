import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
export const LATCHWAY_SCOPE_REGISTRY_KEY = "@latchway:registry";

const NPM_REGISTRY_PINS = Object.freeze([
  `--registry=${NPM_REGISTRY_URL}`,
  `--${LATCHWAY_SCOPE_REGISTRY_KEY}=${NPM_REGISTRY_URL}`,
]);
const PNPM_REGISTRY_PINS = Object.freeze([
  `--config.registry=${NPM_REGISTRY_URL}`,
  `--config.${LATCHWAY_SCOPE_REGISTRY_KEY}=${NPM_REGISTRY_URL}`,
]);

export function npmRegistryArguments(arguments_) {
  return [...arguments_, ...NPM_REGISTRY_PINS];
}

export function pnpmRegistryArguments(arguments_) {
  return [...arguments_, ...PNPM_REGISTRY_PINS];
}

export function registryNpmrc(extraLines = []) {
  return [
    `registry=${NPM_REGISTRY_URL}`,
    `${LATCHWAY_SCOPE_REGISTRY_KEY}=${NPM_REGISTRY_URL}`,
    ...extraLines,
    "",
  ].join("\n");
}

export function writeRegistryNpmrcs(userconfig, globalconfig, extraLines = []) {
  const contents = registryNpmrc(extraLines);
  for (const path of [userconfig, globalconfig]) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, contents, { mode: 0o600 });
  }
}

export function isolatedRegistryEnvironment(baseEnvironment, {
  cache,
  excludedNames = [],
  globalconfig,
  userconfig,
}) {
  const explicitlyExcluded = new Set(excludedNames.map((name) => name.toLowerCase()));
  const environment = Object.fromEntries(Object.entries(baseEnvironment).filter(([name]) => {
    const normalized = name.toLowerCase();
    return !explicitlyExcluded.has(normalized) && !isRegistryConfigurationOverride(normalized);
  }));
  return {
    ...environment,
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_GLOBALCONFIG: globalconfig,
    NPM_CONFIG_USERCONFIG: userconfig,
    PNPM_CONFIG_CACHE: cache,
    PNPM_CONFIG_GLOBALCONFIG: globalconfig,
    PNPM_CONFIG_USERCONFIG: userconfig,
  };
}

function isRegistryConfigurationOverride(normalizedName) {
  const prefix = normalizedName.startsWith("npm_config_")
    ? "npm_config_"
    : normalizedName.startsWith("pnpm_config_") ? "pnpm_config_" : undefined;
  if (prefix === undefined) return false;
  const key = normalizedName.slice(prefix.length);
  return key.includes("auth") || key.includes("registry") || new Set([
    "cache",
    "globalconfig",
    "userconfig",
  ]).has(key);
}

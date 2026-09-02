import { isDeepStrictEqual } from "node:util";

const COMMIT = /^[0-9a-f]{40}$/u;

export function validateIOSSwiftPMLocks({
  packageSwift,
  packageResolved,
  expectedRepository,
  expectedCommit,
}) {
  if (typeof packageSwift !== "string" || packageSwift.length === 0
      || typeof expectedRepository !== "string"
      || expectedRepository !== "https://github.com/Latchway/latchway-ios-sdk.git"
      || !COMMIT.test(expectedCommit)) {
    throw new Error("The locked iOS SwiftPM dependency identity is invalid.");
  }
  const dependencyPattern = /\.package\(\s*url:\s*"([^"]+)"\s*,\s*revision:\s*"([^"]+)"\s*\)/gu;
  const dependencies = [...packageSwift.matchAll(dependencyPattern)]
    .map((match) => ({ repository: match[1], revision: match[2] }));
  const matchingDependencies = dependencies.filter((dependency) =>
    dependency.repository === expectedRepository
      || /\/latchway-ios-sdk(?:\.git)?$/iu.test(dependency.repository));
  if (matchingDependencies.length !== 1 || !isDeepStrictEqual(matchingDependencies[0], {
    repository: expectedRepository,
    revision: expectedCommit,
  })) {
    throw new Error("Package.swift does not pin the exact release-compatibility iOS source revision.");
  }

  if (packageResolved === null || typeof packageResolved !== "object" || Array.isArray(packageResolved)
      || packageResolved.version !== 3 || !Array.isArray(packageResolved.pins)) {
    throw new Error("Package.resolved has an unsupported SwiftPM lock schema.");
  }
  const matchingPins = packageResolved.pins.filter((pin) =>
    pin?.identity === "latchway-ios-sdk" || pin?.location === expectedRepository);
  const expectedPin = {
    identity: "latchway-ios-sdk",
    kind: "remoteSourceControl",
    location: expectedRepository,
    state: { revision: expectedCommit },
  };
  if (matchingPins.length !== 1 || !isDeepStrictEqual(matchingPins[0], expectedPin)) {
    throw new Error("Package.resolved does not pin the exact release-compatibility iOS source revision.");
  }
}

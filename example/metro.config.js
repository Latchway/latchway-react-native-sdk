const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const workspaceRoot = path.resolve(__dirname, "..");
const sdkSourceRoot = path.join(workspaceRoot, "src");
const clientPackageLink = path.join(
  workspaceRoot,
  "node_modules",
  "@latchway",
  "client",
);
const clientPackageRoot = fs.realpathSync(clientPackageLink);
const clientPackage = JSON.parse(
  fs.readFileSync(path.join(clientPackageRoot, "package.json"), "utf8"),
);

if (clientPackage.name !== "@latchway/client") {
  throw new Error(
    `expected ${clientPackageLink} to resolve to @latchway/client`,
  );
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

module.exports = mergeConfig(getDefaultConfig(__dirname), {
  // pnpm's checked-in hoisted layout installs workspace dependencies at this
  // root. The client dependency is a checked-in pnpm link to its sibling
  // package during monorepo development, so its exact real path must also be
  // visible. Keep Metro's standard resolver for everything else.
  watchFolders: [workspaceRoot, clientPackageRoot],
  resolver: {
    // Imports originating in the checked-out sibling JavaScript SDK cannot
    // discover this workspace's pnpm-hoisted runtime dependencies through
    // ancestor traversal. These are the standard app/workspace roots Metro
    // should consult after normal package-relative resolution.
    nodeModulesPaths: [
      path.join(__dirname, "node_modules"),
      path.join(workspaceRoot, "node_modules"),
    ],
    resolveRequest: (context, moduleName, platform) => {
      // The source package uses Node ESM `.js` specifiers that TypeScript emits
      // unchanged. During this workspace-only source build, map only an exact,
      // existing sibling under this SDK's src/ tree back to its `.ts` source.
      if (moduleName.startsWith("./") && moduleName.endsWith(".js") &&
          isInside(sdkSourceRoot, context.originModulePath)) {
        const candidate = path.resolve(
          path.dirname(context.originModulePath),
          `${moduleName.slice(0, -3)}.ts`,
        );
        if (isInside(sdkSourceRoot, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { filePath: candidate, type: "sourceFile" };
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
});

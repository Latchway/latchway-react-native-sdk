import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

runPackageScript("build");
const first = await digestTree();
runPackageScript("build");
const second = await digestTree();
if (first !== second) throw new Error("Two clean builds produced different lib trees.");

function runPackageScript(name) {
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) throw new Error("Run reproducibility verification through pnpm.");
  if (/\.[cm]?js$/u.test(packageManager)) {
    execFileSync(process.execPath, [packageManager, name], {
      cwd: new URL("..", import.meta.url),
      stdio: "inherit",
    });
  } else {
    execFileSync(packageManager, [name], { cwd: new URL("..", import.meta.url), stdio: "inherit" });
  }
}

async function digestTree() {
  const root = new URL("../lib/", import.meta.url);
  const entries = (await readdir(root, { recursive: true })).sort();
  const hash = createHash("sha256");
  for (const entry of entries) {
    const url = new URL(entry, root);
    try {
      const bytes = await readFile(url);
      hash.update(entry).update("\0").update(bytes).update("\0");
    } catch (error) {
      if (error?.code !== "EISDIR") throw error;
    }
  }
  return hash.digest("hex");
}

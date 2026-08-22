import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

// This file asks git what is tracked, which needs both a git checkout and the git
// binary. Neither exists in the deployed image, and the assertion is about repository
// hygiene rather than runtime behaviour, so it is skipped rather than failed when the
// repository is not there (found 2026-08-22).
const repositoryRoot = new URL("..", import.meta.url);
const hasRepository = (() => {
  if (!existsSync(new URL(".git", repositoryRoot))) return false;
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const skipWithoutRepository = hasRepository ? false : "no git checkout in this environment";

function trackedFiles(...paths: string[]) {
  return execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

test("runtime secrets and generated build output stay outside version control", { skip: skipWithoutRepository }, async () => {
  assert.equal(trackedFiles(".env"), "", ".env must never be committed");
  assert.equal(trackedFiles("dist"), "", "dist must be rebuilt from src, not committed");
  assert.equal(trackedFiles("*.php"), "", "legacy PHP bot adapters must not remain tracked");

  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  const rules = new Set(ignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  assert.equal(rules.has(".env"), true);
  assert.equal(rules.has("dist/"), true);
});

test("smoke tooling requires an explicit tenant instead of targeting a named restaurant", { skip: skipWithoutRepository }, async () => {
  const script = await readFile(new URL("../scripts/agentSmoke.ts", import.meta.url), "utf8");
  assert.doesNotMatch(script, /SMOKE_INSTANCE_ID\s*\|\|\s*["']prestige["']/);
  assert.match(script, /SMOKE_INSTANCE_ID_REQUIRED/);
});

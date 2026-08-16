import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

function trackedFiles(...paths: string[]) {
  return execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  }).trim();
}

test("runtime secrets and generated build output stay outside version control", async () => {
  assert.equal(trackedFiles(".env"), "", ".env must never be committed");
  assert.equal(trackedFiles("dist"), "", "dist must be rebuilt from src, not committed");

  const ignore = await readFile(new URL("../.gitignore", import.meta.url), "utf8");
  const rules = new Set(ignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  assert.equal(rules.has(".env"), true);
  assert.equal(rules.has("dist/"), true);
});

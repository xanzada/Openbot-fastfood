import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";

function fixture(get: () => Promise<string | null>) {
  const logs: unknown[][] = [];
  const client = {isReady: true, isOpen: true, on() {return this;}, get};
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL("../src/services/redis.service.ts", import.meta.url), "utf8"), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText;
  vm.runInNewContext(code, {
    exports, process: {env: {}}, URL, Buffer, setTimeout, clearTimeout,
    console: {log: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args), error: (...args: unknown[]) => logs.push(args)},
    require(name: string) {
      if (name === "node:crypto") return crypto;
      if (name === "redis") return {createClient: () => client};
      throw new Error("unexpected dependency");
    },
  });
  return {api: exports, logs};
}
for (const mode of ["read-error", "invalid-json"]) {
  test("complaint media failure preserves null fallback without private logs: " + mode, async () => {
    const phone = String(7_700_000_0456);
    const h = fixture(async () => {
      if (mode === "read-error") throw new Error("SYNTHETIC_PRIVATE_BODY Bearer SYNTHETIC_TOKEN " + phone);
      return "{SYNTHETIC_PRIVATE_BODY SYNTHETIC_TOKEN";
    });
    assert.equal(await h.api.getComplaintMedia("private-fixture", phone), null);
    assert.ok(h.logs.length > 0, "failure still has operational diagnostics");
    const logged = JSON.stringify(h.logs);
    for (const privateValue of [phone, "SYNTHETIC_PRIVATE_BODY", "SYNTHETIC_TOKEN", "Bearer"]) {
      assert.equal(logged.includes(privateValue), false, "no private identities or arbitrary error bodies in diagnostics");
    }
  });
}
test("valid complaint media still returns the saved evidence", async () => {
  const media = {base64: "Yg==", mimeType: "image/jpeg"};
  const h = fixture(async () => JSON.stringify(media));
  assert.equal(JSON.stringify(await h.api.getComplaintMedia("private-fixture", "synthetic-customer")), JSON.stringify(media));
  assert.equal(h.logs.length, 0);
});

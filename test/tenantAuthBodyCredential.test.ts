import test from "node:test";
import assert from "node:assert/strict";
import { assertTenantSecret } from "../src/services/tenantAuth.service.js";

// Verified against the live webhook 2026-08-12: a probe that put the tenant key in
// the JSON body as `token` was denied with 403 INVALID_TENANT_SECRET, which is the
// same three words the log shows for a key that is simply wrong. The contract is
// `?token=` or `X-Tenant-Key`, and the body is the easier mistake to make because
// every other field of this webhook is JSON. The denial must not change - only
// become diagnosable, and without the credential itself reaching the log.
const CONFIG = { instance_id: "prestige", alemi_secret: "real-secret" };

let lines: string[] = [];
const originalInfo = console.info;
console.info = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
process.on("exit", () => { console.info = originalInfo; });

function req(overrides: Record<string, any> = {}) {
  return { headers: {}, query: {}, body: { instance: "prestige" }, ...overrides } as any;
}

function denied(body: Record<string, any>, overrides: Record<string, any> = {}) {
  lines = [];
  assert.throws(
    () => assertTenantSecret(req({ body: { instance: "prestige", ...body }, ...overrides }), CONFIG, "kanban"),
    /INVALID_TENANT_SECRET/,
  );
  return lines.join("\n");
}

function bodyDiagnostics(log: string) {
  return log.split("\n").filter((line) => line.includes("credential_in_body"));
}

test("a key in the JSON body is still denied, exactly as before", () => {
  denied({ token: "real-secret" });
});

test("the denial names the body field so the integrator knows where to move the key", () => {
  const log = denied({ token: "real-secret" });
  const found = bodyDiagnostics(log);
  assert.equal(found.length, 1, "one credential_in_body diagnostic");
  assert.match(found[0], /reads \?token= or X-Tenant-Key only/);
  assert.match(found[0], /"fields":"token"/);
  assert.match(found[0], /"instance":"prestige"/);
});

test("the diagnostic logs field names only, never the credential", () => {
  const log = denied({ secret_key: "real-secret", api_key: "another-one" });
  assert.doesNotMatch(log, /real-secret/);
  assert.doesNotMatch(log, /another-one/);
  assert.match(bodyDiagnostics(log)[0], /"fields":"secret_key,api_key"/);
});

test("a caller that used the documented header is accepted and gets no diagnostic", () => {
  lines = [];
  assertTenantSecret(req({ headers: { "x-tenant-key": "real-secret" } }), CONFIG, "kanban");
  assert.equal(bodyDiagnostics(lines.join("\n")).length, 0);
});

test("a wrong key presented the documented way is not reported as a body mistake", () => {
  const log = denied({}, { query: { token: "wrong-key" } });
  assert.equal(bodyDiagnostics(log).length, 0);
});

test("a body field holding something other than a string is not mistaken for a credential", () => {
  const log = denied({ token: ["a", "b"], key: {} });
  assert.equal(bodyDiagnostics(log).length, 0);
});

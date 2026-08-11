import test from "node:test";
import assert from "node:assert/strict";
import { checkAlemiHub } from "../src/services/diagnostics.service.js";

// 2026-08-12: hub.alemi.kz was the only dependency missing from boot. A rotated
// secret or a moved API URL surfaced hours later as a guest being told there was
// no active order, never as a startup failure.
test("a reachable hub is reported per tenant, with its own credential", async () => {
  const seen: string[] = [];
  const checks = await checkAlemiHub(
    async () => [
      { instance_id: "prestige", alemi_secret: "s1", alemi_api_url: "https://hub.alemi.kz/" },
      { instance_id: "second", alemi_secret: "s2", alemi_api_url: "https://hub.alemi.kz/" },
    ],
    (async (instance: string, command: string) => {
      seen.push(`${instance}:${command}`);
      return { accepting_orders: true };
    }) as any
  );
  assert.deepEqual(seen.sort(), ["prestige:runtime.status.get", "second:runtime.status.get"]);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.ok));
  assert.equal(checks[0].name, "alemi_hub[prestige]");
  assert.equal(checks[0].target, "hub.alemi.kz");
  assert.match(String(checks[0].status), /accepting_orders=true/);
});

test("an unreachable hub fails the check instead of throwing", async () => {
  const checks = await checkAlemiHub(
    async () => [{ instance_id: "prestige", alemi_secret: "s1", alemi_api_url: "https://hub.alemi.kz/" }],
    (async () => {
      throw new Error("ALEMI_HTTP_401");
    }) as any
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(String(checks[0].message), /ALEMI_HTTP_401/);
});

test("a tenant list with no hub credential is a failed check, not a silent pass", async () => {
  const noSecret = await checkAlemiHub(async () => [{ instance_id: "prestige" }], (async () => ({})) as any);
  assert.equal(noSecret[0].ok, false);
  assert.match(String(noSecret[0].message), /no tenant carries alemi_secret \(tenants=1\)/);

  const none = await checkAlemiHub(async () => [], (async () => ({})) as any);
  assert.equal(none[0].ok, false);
  assert.match(String(none[0].message), /no tenant config could be loaded/);
});

test("a tenant config that cannot be loaded at all never breaks boot", async () => {
  const checks = await checkAlemiHub(async () => {
    throw new Error("PLATFORM_DOWN");
  }, (async () => ({})) as any);
  assert.equal(checks[0].ok, false);
  assert.equal(checks[0].name, "alemi_hub");
});

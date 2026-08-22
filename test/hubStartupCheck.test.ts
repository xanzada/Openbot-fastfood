import test from "node:test";
import assert from "node:assert/strict";
import { checkAlemiHub } from "../src/services/diagnostics.service.js";

// 2026-08-12: hub.alemi.kz was the only dependency missing from boot. A rotated
// secret or a moved API URL surfaced hours later as a guest being told there was
// no active order, never as a startup failure.
const hydrated = (byId: Record<string, Record<string, any>>) =>
  async (instance: string) => byId[instance] ?? null;

test("a reachable hub is reported per tenant, with its own credential", async () => {
  const seen: string[] = [];
  const checks = await checkAlemiHub(
    async () => [{ instance_id: "prestige" }, { instance_id: "second" }],
    (async (instance: string, command: string) => {
      seen.push(`${instance}:${command}`);
      return { accepting_orders: true };
    }) as any,
    hydrated({
      prestige: { instance_id: "prestige", alemi_secret: "s1", alemi_api_url: "https://hub.alemi.kz/" },
      second: { instance_id: "second", alemi_secret: "s2", alemi_api_url: "https://hub.alemi.kz/" },
    })
  );
  assert.deepEqual(seen.sort(), ["prestige:runtime.status.get", "second:runtime.status.get"]);
  assert.equal(checks.length, 2);
  assert.ok(checks.every((check) => check.ok));
  assert.equal(checks[0].name, "alemi_hub[prestige]");
  assert.equal(checks[0].target, "hub.alemi.kz");
  assert.match(String(checks[0].status), /accepting_orders=true/);
});

// The multi-tenant index redacts alemi_secret. Reading the credential from it
// reported "no tenant carries alemi_secret" for a tenant that is configured
// correctly, so the check must re-read each instance authoritatively by id.
test("a redacted index entry is hydrated by id instead of failing the check", async () => {
  const checks = await checkAlemiHub(
    async () => [{ instance_id: "prestige", alemi_secret: "" }],
    (async () => ({ accepting_orders: false })) as any,
    hydrated({ prestige: { instance_id: "prestige", alemi_secret: "s1", alemi_api_url: "https://hub.alemi.kz" } })
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, true);
  assert.equal(checks[0].name, "alemi_hub[prestige]");
  assert.match(String(checks[0].status), /accepting_orders=false/);
});

test("an unreachable hub fails the check instead of throwing", async () => {
  const checks = await checkAlemiHub(
    async () => [{ instance_id: "prestige" }],
    (async () => {
      throw new Error("ALEMI_HTTP_401");
    }) as any,
    hydrated({ prestige: { instance_id: "prestige", alemi_secret: "s1", alemi_api_url: "https://hub.alemi.kz/" } })
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].ok, false);
  assert.match(String(checks[0].message), /ALEMI_HTTP_401/);
});

test("a tenant with no hub credential is a failed check, not a silent pass", async () => {
  const noSecret = await checkAlemiHub(
    async () => [{ instance_id: "prestige" }],
    (async () => ({})) as any,
    hydrated({ prestige: { instance_id: "prestige" } })
  );
  assert.equal(noSecret[0].ok, false);
  assert.equal(noSecret[0].name, "alemi_hub[prestige]");
  assert.match(String(noSecret[0].message), /tenant carries no alemi_secret/);

  // A config that could not be READ is a different fault from a config whose secret
  // field is empty, and this test used to assert the first was reported as the second.
  // During a platform outage every tenant was then reported as mis-configured and the
  // operator was sent to fix tenant rows while the real fault was the platform token
  // (found 2026-08-22). Both are still failures; they just say what they are.
  const unhydratable = await checkAlemiHub(
    async () => [{ instance_id: "prestige" }],
    (async () => ({})) as any,
    async () => {
      throw new Error("PLATFORM_DOWN");
    }
  );
  assert.equal(unhydratable[0].ok, false);
  assert.match(String(unhydratable[0].message), /tenant config could not be loaded/);
  assert.match(String(unhydratable[0].message), /PLATFORM_DOWN/, "the cause must reach the operator");
  assert.doesNotMatch(
    String(unhydratable[0].message),
    /tenant carries no alemi_secret/,
    "a platform outage must not be reported as a tenant misconfiguration"
  );

  const none = await checkAlemiHub(async () => [], (async () => ({})) as any, hydrated({}));
  assert.equal(none[0].ok, false);
  assert.match(String(none[0].message), /no tenant config could be loaded/);
});

test("a tenant config that cannot be loaded at all never breaks boot", async () => {
  const checks = await checkAlemiHub(async () => {
    throw new Error("PLATFORM_DOWN");
  }, (async () => ({})) as any, hydrated({}));
  assert.equal(checks[0].ok, false);
  assert.equal(checks[0].name, "alemi_hub");
});

import assert from "node:assert/strict";
import test from "node:test";
import { hydrateAnalyticsTenantConfig } from "../src/cron/statsCron.js";

test("daily analytics hydrates the exact tenant config even when the list row has no secret", async () => {
  let requestedInstance = "";
  let requestedOptions: Record<string, any> | undefined;
  const hydrated = await hydrateAnalyticsTenantConfig(
    { instance_id: "prestige", brand: "List row" },
    async (instanceId, options) => {
      requestedInstance = instanceId;
      requestedOptions = options;
      return {
        instance_id: "prestige",
        alemi_instance: "hub-prestige",
        alemi_secret: "tenant-runtime-secret",
        brand: "Runtime row",
      };
    },
  );

  assert.equal(requestedInstance, "prestige");
  assert.deepEqual(requestedOptions, { forceRefresh: true });
  assert.equal(hydrated.instance_id, "prestige");
  assert.equal(hydrated.alemi_instance, "hub-prestige");
  assert.equal(hydrated.alemi_secret, "tenant-runtime-secret");
  assert.equal(hydrated.brand, "Runtime row");
});

test("daily analytics fails closed for missing, mismatched, or secretless tenant runtime config", async () => {
  const summary = { instance_id: "prestige" };
  await assert.rejects(
    hydrateAnalyticsTenantConfig(summary, async () => null),
    /ALEMI_TENANT_CONFIG_NOT_FOUND/,
  );
  await assert.rejects(
    hydrateAnalyticsTenantConfig(summary, async () => ({ instance_id: "other", alemi_secret: "wrong-tenant-secret" })),
    /ALEMI_TENANT_CONFIG_MISMATCH/,
  );
  await assert.rejects(
    hydrateAnalyticsTenantConfig(summary, async () => ({ instance_id: "prestige" })),
    /ALEMI_TENANT_SECRET_NOT_CONFIGURED/,
  );
});

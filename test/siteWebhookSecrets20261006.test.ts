import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDlePayload } from "../src/routes/dleWebhook.route.js";
import { createSiteWebhookQueue, type SiteWebhookJob, type SiteWebhookStore } from "../src/services/siteWebhookQueue.service.js";
test("actual normalized nested webhook credentials cannot enter durable payload", async () => {
  const req: any = { body: { instance: "fixture", event_type: "order.created", data: { order_id: "123", tenant_secret: "fixture-secret", token: "fixture-token", customer: { phone: "00000000000", password: "fixture-password" }, items: [{ name: "fixture-item", quantity: 1 }] }, payload: { refreshToken: "fixture-refresh", API_KEY: "fixture-api" } }, query: {} };
  normalizeDlePayload(req);
  let saved: SiteWebhookJob | undefined;
  const store: SiteWebhookStore = { put: async job => { saved = job; return true; }, due: async () => [], claim: async () => false, renew: async () => {}, finish: async () => {}, retry: async () => {} };
  const q = createSiteWebhookQueue({ store, process: async () => ({ status: 200 }) });
  await q.enqueue(req.body);
  const raw = JSON.stringify(saved!.body);
  for (const value of ["fixture-secret", "fixture-token", "fixture-password", "fixture-refresh", "fixture-api"]) assert.equal(raw.includes(value), false, "credential persisted");
  assert.equal(saved!.body.order_id, "123");
  assert.ok(raw.includes("fixture-item")); assert.ok(raw.includes("00000000000"));
});
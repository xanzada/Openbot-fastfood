import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { redisClient, connectRedis } from "../src/services/redis.service.js";
import { dleWebhookRoute } from "../src/routes/dleWebhook.route.js";

test("authenticated HTTP ingress persists before 202, rejects bad credentials, and measures the auth boundary", { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1" }, async () => {
  await connectRedis();
  const instance = "audit-http-" + crypto.randomBytes(3).toString("hex");
  const config = { instance_id: instance, instance, alemi_instance: instance, alemi_secret: "fixture-tenant-secret" };
  let delay = 0;
  const platform = express();
  platform.get("/api/wa/runtime-configs", (_req, res) => res.json({ configs: [config] }));
  platform.get("/api/wa/runtime-configs/:id", async (_req, res) => {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    res.json({ config });
  });
  const ps = platform.listen(0, "127.0.0.1"); await once(ps, "listening");
  process.env.TENANTS_PLATFORM_BASE_URL = "http://127.0.0.1:" + (ps.address() as any).port;
  process.env.TENANTS_PLATFORM_API_TOKEN = "fixture-platform-token";
  process.env.DLE_WEBHOOK_AUTH_REQUIRED = "true";
  await redisClient.set("config:all_restaurants", JSON.stringify([config]), { EX: 60 });
  const app = express(); app.use(express.json()); app.use("/webhook", dleWebhookRoute());
  const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = "http://127.0.0.1:" + (server.address() as any).port + "/webhook";
  const ids: string[] = [];
  const samples: number[] = [];
  try {
    for (let i = 0; i < 25; i++) {
      const body = { instance, action: "new_order", order_id: "133", event_id: crypto.randomUUID(), phone: "00000000000" };
      const start = performance.now();
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tenant-key": config.alemi_secret }, body: JSON.stringify(body) });
      const receipt = await response.json() as any;
      const elapsed = performance.now() - start;
      assert.equal(response.status, 202); assert.equal(receipt.accepted, true);
      ids.push(receipt.job_id);
      const stored = JSON.parse((await redisClient.get("site_webhook:job:" + receipt.job_id))!);
      assert.equal(stored.body.instance, instance); assert.equal(stored.body.event_id, body.event_id);
      if (i >= 5) samples.push(elapsed);
    }
    const invalid = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tenant-key": "wrong-fixture-key" }, body: JSON.stringify({ instance, action: "new_order", order_id: "133", event_id: "denied-event" }) });
    assert.equal(invalid.status, 403);
    const ignored = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tenant-key": config.alemi_secret }, body: JSON.stringify({ instance, event_type: "customer.loyalty_adjusted", event_id: "fixture-loyalty" }) });
    assert.equal(ignored.status, 200); assert.equal((await ignored.json() as any).ignored, true);
    const badOrder = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tenant-key": config.alemi_secret }, body: JSON.stringify({ instance, action: "new_order", order_id: "0", event_id: "bad-order" }) });
    assert.equal(badOrder.status, 400);
    delay = 100;
    const start = performance.now();
    const slow = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-tenant-key": config.alemi_secret }, body: JSON.stringify({ instance, action: "new_order", order_id: "134", event_id: crypto.randomUUID() }) });
    const slowReceipt = await slow.json() as any; ids.push(slowReceipt.job_id);
    const slowMs = performance.now() - start;
    assert.equal(slow.status, 202); assert.ok(slowMs >= 95, "authentication cannot acknowledge before authoritative read");
    samples.sort((a, b) => a - b);
    console.log("INGRESS_RECEIPT " + JSON.stringify({ sampleCount: samples.length, p50ms: samples[Math.floor(samples.length * .5)], p95ms: samples[Math.ceil(samples.length * .95)-1], maxMs: samples.at(-1), authDelay100ms: slowMs, realWhatsAppSends: 0 }));
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => ps.close(() => resolve()));
    for (const id of ids) { await redisClient.zRem("site_webhook:due", id); await redisClient.del("site_webhook:job:" + id); }
    await redisClient.del("config:" + instance); await redisClient.del("config_backup:" + instance); await redisClient.del("config:all_restaurants");
    if (redisClient.isOpen) await redisClient.quit();
  }
});

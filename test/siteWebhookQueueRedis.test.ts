import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { redisClient, connectRedis } from "../src/services/redis.service.js";
import { createSiteWebhookQueue, redisSiteWebhookStore } from "../src/services/siteWebhookQueue.service.js";

test("real Redis persists a failed event for a replacement worker and deduplicates completion", { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1" }, async () => {
  await connectRedis();
  let clock = Date.now(); let firstCalls = 0;
  const instance = `audit-${crypto.randomBytes(3).toString("hex")}`;
  const body = { instance, action: "new_order", order_id: "123", event_id: crypto.randomUUID() };
  const before = createSiteWebhookQueue({ store: redisSiteWebhookStore, now: () => clock, process: async () => { firstCalls++; return { status: 503 }; } });
  const accepted = await before.enqueue(body);
  assert.equal(accepted.inserted, true);
  assert.equal((await before.drain()).processed, 0);
  const pending = JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!);
  assert.equal(pending.attempts, 1); assert.equal(pending.nextAttemptAt - clock, 2_000);
  clock += 2_000; let replacementCalls = 0;
  const after = createSiteWebhookQueue({ store: redisSiteWebhookStore, now: () => clock, process: async payload => {
    replacementCalls++; assert.equal(payload.instance, instance); return { status: 200 };
  } });
  assert.equal((await after.drain()).processed, 1);
  assert.equal(firstCalls, 1); assert.equal(replacementCalls, 1);
  const completed = JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!);
  assert.equal(completed.status, "processed"); assert.equal(completed.body, undefined);
  assert.equal((await after.enqueue(body)).inserted, false);
  await after.drain(); assert.equal(replacementCalls, 1);
});

test("real Redis order lease prevents competing processors and fences a stale owner", { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1" }, async () => {
  await connectRedis();
  const now = Date.now(); const instance = `audit-${crypto.randomBytes(3).toString("hex")}`;
  const body = { instance, action: "new_order", order_id: "124", event_id: crypto.randomUUID() };
  const queue = createSiteWebhookQueue({ store: redisSiteWebhookStore, now: () => now, process: async () => ({ status: 200 }) });
  const accepted = await queue.enqueue(body);
  const job = (await redisSiteWebhookStore.due(now, 24)).find(j => j.id === accepted.id)!;
  assert.equal(await redisSiteWebhookStore.claim(job, "owner-A"), true);
  assert.equal(await redisSiteWebhookStore.claim(job, "owner-B"), false);
  const lane = crypto.createHash("sha256").update(JSON.stringify([instance, body.order_id])).digest("hex");
  await redisClient.set(`site_webhook:lane:${lane}`, "owner-B", { PX: 20_000 });
  await assert.rejects(redisSiteWebhookStore.finish(job, "owner-A"), /LEASE_LOST/);
  assert.equal(JSON.parse((await redisClient.get(`site_webhook:job:${accepted.id}`))!).body.instance, instance);
  await redisSiteWebhookStore.finish(job, "owner-B");
});

test("real Redis quarantines one broken record without blocking healthy orders", { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1" }, async () => {
  await connectRedis();
  const bad = crypto.randomBytes(32).toString("hex");
  await redisClient.set("site_webhook:job:" + bad, "{broken");
  await redisClient.zAdd("site_webhook:due", [{ score: Date.now()-1000, value: bad }]);
  let calls = 0;
  const q = createSiteWebhookQueue({ store: redisSiteWebhookStore, process: async () => { calls++; return { status: 200 }; } });
  await q.enqueue({ instance: "audit-quarantine", action: "new_order", order_id: "129", event_id: crypto.randomUUID() });
  assert.equal((await q.drain()).processed, 1); assert.equal(calls, 1);
  assert.equal(await redisClient.zScore("site_webhook:due", bad), null);
  assert.notEqual(await redisClient.zScore("site_webhook:quarantine", bad), null);
  assert.equal(await redisClient.get("site_webhook:job:" + bad), "{broken");
  await redisClient.zRem("site_webhook:quarantine", bad); await redisClient.del("site_webhook:job:" + bad);
});

test.after(async () => { if (redisClient.isOpen) await redisClient.quit(); });

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { redisClient, connectRedis } from "../src/services/redis.service.js";
import { queueDurableNotification, redisNotificationStore, type NotificationRecord } from "../src/services/durableNotification.service.js";
const enabled = process.env.AUDIT_REDIS_INTEGRATION === "1";
const owned: string[] = [];
function fixture() {
  const prefix = "audit_notification_parent:" + crypto.randomUUID();
  const key = prefix + ":record", index = prefix + ":index";
  owned.push(key, key + ":lock", index, index + ":quarantine", prefix + ":bad", prefix + ":missing");
  return { key, index, prefix };
}
test("real Redis atomic prepare survives an orphan lease and repairs a missing due index", { skip: !enabled }, async () => {
  await connectRedis(); const f = fixture();
  await redisClient.set(f.key + ":lock", "dead-worker", { EX: 120 });
  const row = await queueDurableNotification({ ...f, instanceId: "fixture", text: "original fixture", payload: {}, now: 1000 });
  assert.equal(row.status, "pending"); assert.equal(await redisClient.ttl(f.key), -1);
  assert.equal(await redisClient.ttl(f.index), -1);
  assert.deepEqual(await redisNotificationStore.due(f.index, 1000), [f.key]);
  await redisClient.del(f.index);
  const repeated = await queueDurableNotification({ ...f, instanceId: "fixture", text: "replacement must not overwrite", payload: {}, now: 2000 });
  assert.equal(repeated.text, "original fixture");
  assert.deepEqual(await redisNotificationStore.due(f.index, 2000), [f.key]);
});
test("real Redis fences stale notification writes and renews only the owned delivery lease", { skip: !enabled }, async () => {
  await connectRedis(); const f = fixture();
  const pending = await queueDurableNotification({ ...f, instanceId: "fixture", text: "fixture", payload: {}, now: 1000 });
  assert.equal(await redisNotificationStore.claim(f.key, "owner-A"), true);
  await redisClient.expire(f.key + ":lock", 1);
  await redisNotificationStore.renew!(f.key, "owner-A"); assert.ok(await redisClient.ttl(f.key + ":lock") > 110);
  await assert.rejects(redisNotificationStore.renew!(f.key, "wrong-owner"), /LEASE_LOST/);
  await redisClient.set(f.key + ":lock", "owner-B", { EX: 120 });
  const done: NotificationRecord = { ...pending, status: "delivered", delivered_at: new Date().toISOString() };
  await assert.rejects(redisNotificationStore.save(f.key, f.index, done, "owner-A"), /LEASE_LOST/);
  assert.equal((await redisNotificationStore.get(f.key))!.status, "pending");
  await redisNotificationStore.save(f.key, f.index, done, "owner-B");
  assert.equal((await redisNotificationStore.get(f.key))!.status, "delivered");
  assert.ok(await redisClient.ttl(f.key) > 44 * 86400); assert.deepEqual(await redisNotificationStore.due(f.index, 1000), []);
});
test("real Redis isolates missing/corrupt records without blocking healthy notification", { skip: !enabled }, async () => {
  await connectRedis(); const f = fixture();
  await queueDurableNotification({ ...f, instanceId: "fixture", text: "fixture", payload: {}, now: 1000 });
  await redisClient.set(f.prefix + ":bad", "{broken");
  await redisClient.zAdd(f.index, [{ score: 1, value: f.prefix + ":bad" }, { score: 2, value: f.prefix + ":missing" }]);
  assert.deepEqual(await redisNotificationStore.due(f.index, 1000), [f.key]);
  assert.equal(await redisClient.zCard(f.index + ":quarantine"), 2);
  assert.equal(await redisClient.get(f.prefix + ":bad"), "{broken");
});
test("real Redis rejects a foreign prepared row before touching its TTL or index", { skip: !enabled }, async () => {
  await connectRedis(); const f = fixture();
  await redisClient.set(f.key, JSON.stringify({ instance_id: "foreign", status: "pending", next_attempt_at: 1000 }), { EX: 60 });
  await assert.rejects(queueDurableNotification({ ...f, instanceId: "fixture", payload: {}, now: 1000 }), /SCOPE_MISMATCH/);
  assert.ok(await redisClient.ttl(f.key) > 50); assert.equal(await redisClient.exists(f.index), 0);
});
test.after(async () => { if (redisClient.isOpen) { if (owned.length) await redisClient.del(owned); await redisClient.quit(); } });

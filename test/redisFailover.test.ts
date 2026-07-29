import test from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";
process.env.OPENBOT_INBOUND_BUFFER_MS = "600";

const { bufferInboundText, guardIncomingMessage, markInboundDone } = await import("../src/services/inboundGuard.service.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

test("Redis loss falls open into an instance-scoped in-memory guard", async () => {
  const base = {
    instanceId: "tenant-a",
    phone: "77000000001",
    text: "Сәлем",
    messageId: "redis-down-message",
  };

  const first = await guardIncomingMessage(base);
  assert.equal(first.blocked, false);
  assert.equal(first.source, "redis_fail_open");

  const concurrentReplay = await guardIncomingMessage(base);
  assert.equal(concurrentReplay.blocked, true);
  assert.equal(concurrentReplay.reason, "duplicate_processing_local");

  await markInboundDone(base.instanceId, base.messageId);
  const completedReplay = await guardIncomingMessage(base);
  assert.equal(completedReplay.blocked, true);
  assert.equal(completedReplay.reason, "duplicate_done_local");

  const otherTenant = await guardIncomingMessage({ ...base, instanceId: "tenant-b" });
  assert.equal(otherTenant.blocked, false);
  assert.equal(otherTenant.source, "redis_fail_open");
});

test("Redis loss still coalesces rapid customer fragments in a tenant-local buffer", async () => {
  const first = bufferInboundText({
    instanceId: "tenant-buffer",
    phone: "77000000002",
    messageId: "fragment-1",
    text: "Сәлем",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const second = bufferInboundText({
    instanceId: "tenant-buffer",
    phone: "77000000002",
    messageId: "fragment-2",
    text: "Кімсің сен?",
  });
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.leader).length, 1);
  assert.equal(results.find((result) => result.leader)?.text, "Сәлем Кімсің сен?");
});

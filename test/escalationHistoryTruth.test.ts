import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient } = await import("../src/services/redis.service.js");
test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// B32, found 2026-08-23: all three escalation lanes wrote "operator case created" into the
// history unconditionally - including when routeComplaintToAdmin returned
// action:"escalation_failed" with caseId:null, which is what it returns when
// createOperatorCase could not write (Redis down, hub refusing). Support reading the chat
// back saw a case that never existed, with caseId:null right beside the claim.

test("the history entry states the outcome, not the attempt", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // Same class as the escalation_failed action fix, which cost 48 hours of invisible SOS
  // failures: the record has to say what happened.
  assert.match(route, /routing\.escalationAvailable \? "operator case created" : `operator case FAILED \(\$\{routing\.action\}\)`/);
  // The raw action is kept so every failed escalation is greppable, not just countable.
  assert.match(route, /routingAction: routing\.action/);
  assert.match(route, /escalationAvailable: routing\.escalationAvailable/);
});

test("all three escalation lanes were fixed, not just the one that was read", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // media_analysis, cancel_request and the post-agent text lane each write their own copy.
  // Fixing one would leave the other two lying, and they are the lanes a photo complaint
  // and a cancellation take.
  assert.equal((route.match(/operator case FAILED/g) || []).length, 3);
  assert.equal((route.match(/routingAction: routing\.action/g) || []).length, 3);
  // And the unconditional wording must be gone from every one of them.
  assert.equal((route.match(/"system", "operator case created"/g) || []).length, 0);
});

test("a successful escalation still reads exactly as before", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // The success string is unchanged, so existing panel and support tooling that greps for
  // it keeps working.
  assert.match(route, /"operator case created"/);
  // caseId and mediaAttached stay in the metadata.
  assert.equal((route.match(/caseId: routing\.caseId/g) || []).length, 3);
  assert.equal((route.match(/mediaAttached: routing\.mediaAttached/g) || []).length, 3);
});

test("the developer is still alerted when escalation was impossible", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  // The history entry is for people reading the chat; the alert is what wakes someone up.
  // Both must exist, or a Redis outage during a complaint is silent again.
  assert.equal((route.match(/ADMIN_PHONE_NOT_CONFIGURED_FOR_COMPLAINT/g) || []).length, 3);
  assert.equal((route.match(/if \(!routing\.escalationAvailable\)/g) || []).length, 3);
});

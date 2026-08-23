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

// B28, found 2026-08-23: two ways the clarification state machine misfired, both about
// treating "could not read" as a definite answer.

test("an unreadable clarification state reports error, not 'nothing pending'", async () => {
  // This suite runs with REDIS_URL pointed at a closed port, so this is the real path.
  const { takeComplaintClarification } = await import("../src/services/redis.service.js");
  assert.equal(await takeComplaintClarification("probe", "77000000000"), "error");
});

test("a menu question after a pending clarification no longer opens a silent case", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const block = route.slice(route.indexOf("const shouldRouteComplaint ="), route.indexOf("if (needsClarification)"));
  // Every other term of this conjunction is already false for a menu question, so without
  // this guard the pending flag alone pushed a pizza question into the escalation lane -
  // case created, reply talked about pizza.
  assert.match(block, /&& !menuQuestion/);
  // The guard must sit in shouldRouteComplaint itself, not only in needsClarification:
  // dropping the flag happens either way, but the CASE must not be opened.
});

test("an unknown state makes both branches stand down", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const block = route.slice(route.indexOf("const awaitingDetailRaw ="), route.indexOf("const finalText ="));
  assert.match(block, /awaitingDetailRaw === "error"/);
  assert.match(block, /!clarificationUnknown\s*\n?\s*&& \(askedForOperator/);
  assert.match(block, /&& !clarificationUnknown/);
  // The literal word must never leak into the operator summary via the join.
  assert.match(block, /clarificationUnknown \? null : \(awaitingDetailRaw as string \| null\)/);
});

test("the AI-tool lane keeps clarify-first on an unknown state", async () => {
  const routing = await read("../src/services/complaintRouting.service.ts");
  // Fail-open was tried and rejected by the suite: a Redis outage means
  // createOperatorCase is down too, so it only reached escalation_failed sooner and broke
  // the clarify-first contract. The lane maps the error back to "nothing pending".
  assert.match(routing, /firstDemandRaw === "error" \? null : firstDemandRaw/);
  assert.match(routing, /if \(firstDemand === null\)/);
  // The route, by contrast, stands both branches down on the same error.
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  assert.match(route, /&& !clarificationUnknown/);
});

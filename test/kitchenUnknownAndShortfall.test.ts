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

const { classifyKitchenSalesPolicy } = await import("../src/services/kitchenPolicy.service.js");
const { resolveAgentToolPlan } = await import("../src/agent/toolPolicy.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// Two defects found 2026-08-23 by re-auditing the payment and kitchen paths. Both share
// a shape: the code treated the absence of information as a specific, convenient answer.

// ---------------------------------------------------------------------------- B30
// A failed hub read defaulted every sales flag to "open", so the bot kept selling
// through an emergency stop, a vacation or outside work hours as if the kitchen had
// answered "we are open".

test("a failed runtime read is not an answer of 'open'", () => {
  // Two shapes mean "we could not read the kitchen". buildFactsPrompt passes
  // ctx.runtimeStatus, which preloadContext sets to null when the hub read fails...
  const noObject = classifyKitchenSalesPolicy(null);
  assert.equal(noObject.stateKnown, false);
  assert.equal(noObject.mode, "unknown", "mode:'normal' here was a fact we did not have");

  // ...and hardRealtimeContext, which is ALWAYS built, says so in a field:
  // runtime_available: Boolean(runtimeStatus). That is the production shape.
  const saysUnavailable = classifyKitchenSalesPolicy({ runtime_available: false, wait_time: 0 });
  assert.equal(saysUnavailable.stateKnown, false);
  assert.equal(saysUnavailable.mode, "unknown");
});

test("a partial runtime still defaults its missing flags to unrestricted", () => {
  // This is deliberate and load-bearing: a hub object that omits a field means "not
  // restricted", and toolPolicy relies on it. Only an explicitly unavailable runtime
  // changed behaviour.
  const partial = classifyKitchenSalesPolicy({ runtime_available: true });
  assert.equal(partial.stateKnown, true, "an answer, however sparse, IS an answer");
  assert.equal(partial.mode, "normal");
  assert.equal(partial.isAcceptingOrders, true);
  assert.equal(partial.withinWorkHours, true);
  assert.equal(partial.delivery, true);
  assert.equal(partial.pickup, true);
});

test("an unknown kitchen does not refuse to sell either", () => {
  // Telling guests a working kitchen is closed because one read timed out would trade a
  // rare wrong sale for a constant wrong refusal. The honest answer is "confirm first",
  // not "closed".
  const unknown = classifyKitchenSalesPolicy({ runtime_available: false });
  assert.equal(unknown.blocksAllSales, false);
  assert.equal(unknown.requiresConsent, false);
});

test("every real kitchen state is unchanged by the unknown branch", () => {
  const cases: [Record<string, any>, string, boolean][] = [
    [{ is_accepting_orders: false, within_work_hours: true }, "indefinite", true],
    [{ within_work_hours: false }, "off_hours", true],
    [{ is_emergency: true, within_work_hours: true }, "indefinite", true],
    [{ wait_time: 60 }, "busy", false],
    [{ wait_time: 200 }, "critical", true],
    [{ delivery: true, pickup: false }, "channel_limited", false],
    [{ wait_time: 10 }, "normal", false],
  ];
  for (const [runtime, expectedMode, expectedBlocks] of cases) {
    const policy = classifyKitchenSalesPolicy(runtime);
    assert.equal(policy.mode, expectedMode, `mode for ${JSON.stringify(runtime)}`);
    assert.equal(policy.blocksAllSales, expectedBlocks, `blocksAllSales for ${JSON.stringify(runtime)}`);
    assert.equal(policy.stateKnown, true, "a runtime that does not deny availability is known");
  }
});

test("the unknown state changes the fingerprint, so a consent given blind is not reused", () => {
  // The fingerprint is what pending kitchen consent is matched against. If unknown and
  // normal hashed alike, a guest's consent to an unknown state would silently carry over
  // to a kitchen that later answered "busy".
  assert.notEqual(
    classifyKitchenSalesPolicy({ runtime_available: false }).fingerprint,
    classifyKitchenSalesPolicy({ runtime_available: true }).fingerprint
  );
});

test("an unknown kitchen pins a live re-read instead of selling on the default", () => {
  const plan = resolveAgentToolPlan({
    instanceId: "probe",
    language: "kk",
    text: "сәлем, пицца тапсырыс беремін",
    phone: "77000000000",
    config: {},
    // The production shape: the hub read failed, so preloadContext left runtimeStatus
    // null and flagged it on the always-present hardRealtimeContext.
    runtimeStatus: null,
    hardRealtimeContext: { runtime_available: false, wait_time: 0 },
    activeOrder: null,
    activeShiftNotes: [],
    chatHistory: [],
  } as any);
  assert.ok(
    plan.requiredTools.includes("getKitchenStatus"),
    "a turn that cannot see the kitchen must spend one call finding out"
  );
  assert.ok(plan.reason.includes("kitchen_state_unknown"));
});

test("a healthy runtime does not pay for an extra kitchen read", () => {
  // The pin must not fire on every ordinary turn, or every guest pays a hub call.
  const plan = resolveAgentToolPlan({
    instanceId: "probe",
    language: "kk",
    text: "Пепперони бар ма, бағасы қанша?",
    phone: "77000000000",
    config: {},
    runtimeStatus: { runtime_available: true, wait_time: 0 },
    hardRealtimeContext: { runtime_available: true, wait_time: 0 },
    activeOrder: null,
    activeShiftNotes: [],
    chatHistory: [],
  } as any);
  assert.equal(plan.reason.includes("kitchen_state_unknown"), false);
});

test("the model is told the state is unknown, not told it is normal", async () => {
  const source = await read("../src/context/buildFactsPrompt.ts");
  assert.match(source, /kitchen_state_known: policy\.stateKnown/);
  assert.match(source, /kitchen_state_unknown_rule/);
  // The rule must send the agent to the live tool, not invite it to guess.
  assert.match(source, /Call getKitchenStatus before confirming an order/);
});

// ---------------------------------------------------------------------------- B21
// A short payment told the guest an operator had been notified, and notified nobody.

test("the shortfall lane opens an operator case before promising one", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const shortfall = route.slice(route.indexOf("if (isShortfall) {"));
  const body = shortfall.slice(0, shortfall.indexOf("} else {"));
  // It used to call only deliverReceiptToClient + sendCustomerReplyAndFinish, so there
  // was no case, no red panel row and no hub signal - while the reply said an operator
  // had been told. deliverReceiptToClient does reach the hub, but its operator comment
  // is sender/amount/bank only and never says the amount was SHORT.
  assert.match(body, /await routeComplaintToAdmin\(ctx, \{/);
  assert.match(body, /source: "payment_shortfall"/);
  assert.match(body, /urgency: "high"/);
  // The summary must carry the numbers, or the operator cannot act on it.
  assert.match(body, /жетпейді \$\{remaining\}/);
});

test("the sentence about the operator is only said when the case exists", async () => {
  const route = await read("../src/routes/whatsappWebhook.route.ts");
  const shortfall = route.slice(route.indexOf("if (isShortfall) {"));
  const body = shortfall.slice(0, shortfall.indexOf("} else {"));
  // createOperatorCase is wrapped in a catch that returns null, so on a Redis outage the
  // promise must simply not be made rather than being made falsely.
  assert.match(body, /shortfallRouting\.escalationAvailable/);
  assert.match(body, /const operatorLine =/);
  // Both languages take the conditional line, not a hardcoded claim.
  assert.match(body, /Отправьте новый чек в этот чат\.\$\{operatorLine\}/);
  assert.match(body, /Жаңа чекті осы чатқа жіберіңіз\.\$\{operatorLine\}/);
  assert.doesNotMatch(body, /чат\. Оператор уже уведомлён/);
});

test("a payment shortfall can never be dropped as a menu question", async () => {
  const routing = await read("../src/services/complaintRouting.service.ts");
  // The guest's caption on a receipt photo often names a dish, and isLikelyMenuQuestion
  // would then discard the whole escalation with escalationAvailable:true - the exact
  // silent-drop shape that was fixed for media and long voice.
  assert.match(routing, /input\.source !== "payment_shortfall"/);
});

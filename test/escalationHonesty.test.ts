import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// No live redis in the test container: fail fast and do not let reconnect timers
// keep the process alive (convention from redisFailover.test.ts, enforced after a
// real 12-minute hang on 2026-08-22).
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const {
  routeComplaintToAdmin,
  buildComplaintAckReply,
  buildEscalationUnavailableReply,
} = await import("../src/services/complaintRouting.service.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const CTX = (text: string, language: "kk" | "ru" = "kk") =>
  ({ instanceId: "test-instance", phone: "77000000888", text, language, config: {} }) as any;

// ---------------------------------------------------------------------------- A1
// createOperatorCase is wrapped in a .catch that yields null (Redis unreachable,
// hub refusing). The routing result nevertheless reported action
// "operator_case_created", and both instructions.ts and the tool description teach
// the model that this value means the operator WAS notified. So during a Redis
// outage a guest with a real incident was told a person would contact them while
// no case, no panel SOS and no hub signal existed. Redis is unreachable in this
// test file by design, which is exactly the failing condition.

test("a case that could not be created is reported as escalation_failed, not as success", async () => {
  const result = await routeComplaintToAdmin(CTX("заказ привезли холодный и не тот соус положили", "ru"), {
    summary: "Холодный заказ",
    customerText: "заказ привезли холодный и не тот соус положили",
    source: "ai_tool_escalate_to_admin",
  });
  assert.equal(result.caseId, null, "no case can exist without Redis");
  assert.equal(result.escalationAvailable, false);
  assert.notEqual(result.action, "operator_case_created", "the model must not be told the operator was notified");
  assert.equal(result.action, "escalation_failed");
});

test("the guest is not promised a human that was never told", async () => {
  const promise = "Извините за ситуацию. Я передал жалобу администратору, он проверит и свяжется с вами.";
  const result = await routeComplaintToAdmin(CTX("заказ привезли холодный и не тот соус положили", "ru"), {
    summary: "Холодный заказ",
    customerText: "заказ привезли холодный и не тот соус положили",
    customerReply: promise,
    source: "ai_tool_escalate_to_admin",
  });
  assert.notEqual(result.customerReply, promise, "a false promise must not reach the guest");
  assert.equal(result.customerReply, buildEscalationUnavailableReply("ru"));
  assert.match(result.customerReply, /сбо|позвоните/i, "the guest is told what to do instead");
});

test("the honest fallback exists in both languages and promises nothing", () => {
  for (const language of ["kk", "ru"] as const) {
    const text = buildEscalationUnavailableReply(language);
    assert.ok(text.length > 30);
    assert.notEqual(text, buildComplaintAckReply(language), "it must not be the promise text");
  }
  assert.doesNotMatch(buildEscalationUnavailableReply("kk"), /байланысады/, "no promise of a callback");
  assert.doesNotMatch(buildEscalationUnavailableReply("ru"), /свяжется/, "no promise of a callback");
});

// ---------------------------------------------------------------------------- B2
// isLikelyMenuQuestion refused escalation for EVERY source, and returned
// escalationAvailable:true so the caller skipped its developer alert and still sent
// an apology promising an operator. MENU_QUESTION_RE matches "бар ма", "қанша тұра",
// "сколько стоит", "қандай" - all extremely common in a photo caption or a
// cancellation sentence.

test("a photo of a wrong order is not discarded because its caption mentions the menu", async () => {
  const caption = "бұл дұрыс емес, пепперони бар ма еді?";
  const result = await routeComplaintToAdmin(CTX(caption), {
    summary: "Фото: қате тапсырыс",
    customerText: caption,
    source: "media_analysis",
    media: { base64: "aGVsbG8=", mimeType: "image/jpeg" },
  });
  assert.notEqual(result.action, "skipped_menu_question", "photo evidence must never be dropped as a menu question");
});

test("a cancellation is not discarded because it mentions a price", async () => {
  const text = "заказ отмените, сколько стоит доставка";
  const result = await routeComplaintToAdmin(CTX(text, "ru"), {
    summary: text,
    customerText: text,
    source: "cancel_request",
  });
  assert.notEqual(result.action, "skipped_menu_question");
});

test("a too-long voice note is not discarded as a menu question", async () => {
  const result = await routeComplaintToAdmin(CTX("қандай сусындар бар"), {
    summary: "Клиент ұзақ дауыстық хабарлама жіберді",
    customerText: "қандай сусындар бар",
    source: "long_voice",
  });
  assert.notEqual(result.action, "skipped_menu_question");
});

test("a bare menu question on the AI tool lane is still refused - that guard stays", async () => {
  // The 2026-08-20 false positives ("Суық суы бар ма?" opening an SOS) must not
  // come back. The skip is narrowed by source, not removed.
  const result = await routeComplaintToAdmin(CTX("Суық суы бар ма?"), {
    summary: "Суық суы бар ма",
    customerText: "Суық суы бар ма?",
    source: "ai_tool_escalate_to_admin",
  });
  assert.equal(result.action, "skipped_menu_question");
  assert.equal(result.caseId, null);
});

test("a bare menu question on the webhook text lane is still refused", async () => {
  const result = await routeComplaintToAdmin(CTX("шашлык қанша тұрады"), {
    summary: "шашлык қанша тұрады",
    customerText: "шашлык қанша тұрады",
    source: "human_request",
  });
  assert.equal(result.action, "skipped_menu_question");
});

// ---------------------------------------------------------------------------- B1
// kitchenGateReply returns unconditionally once the kitchen is closed or busy, and
// it runs BEFORE the agent and before the post-agent escalation gate. A complaint
// arriving after closing time was therefore answered with opening hours and
// escalated nowhere. Complaints about late or cold delivery arrive near closing
// time, so this is the common case, not an edge case.

test("the kitchen gate stands down for a complaint, a human request and a cancellation", async () => {
  const route = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const gate = route.slice(route.indexOf("async function kitchenGateReply"), route.indexOf("const policy = classifyKitchenSalesPolicy"));
  assert.match(gate, /isLikelyComplaintText\(ctx\.text\)/, "a complaint must pass through the kitchen gate");
  assert.match(gate, /isLikelyOperatorRequestText\(ctx\.text\)/, "a request for a person must pass through");
  assert.match(gate, /isOrderCancellationRequest\(ctx\.text\)/, "a cancellation must pass through");
  assert.match(gate, /return null;/, "and it must return null so the escalation lanes run");
});

test("operational preemption stands down for a complaint and a human request", async () => {
  const route = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const fn = route.slice(route.indexOf("function operationalPreemptionReply"), route.indexOf("// busyKitchenReply used to hard-code"));
  assert.match(fn, /isLikelyComplaintText\(ctx\.text\) \|\| isLikelyOperatorRequestText\(ctx\.text\)/);
});

// --------------------------------------------------------------------------- B17
test("the long-voice lane uses the source string complaintRouting actually compares", async () => {
  const route = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const routing = await readFile(new URL("../src/services/complaintRouting.service.ts", import.meta.url), "utf8");
  assert.match(routing, /input\.source === "long_voice"/, "the comparison value");
  assert.doesNotMatch(route, /source: "long_voice_requires_operator"/, "the mismatched value must be gone");
  assert.match(route, /source: "long_voice",/, "so the operator card says long_voice, not complaint");
});

// ----------------------------------------------------------- contract regression
test("the clarify-first gate still holds after the menu skip was narrowed", async () => {
  const { buildEscalationClarifyQuestion } = await import("../src/services/complaintRouting.service.js");
  const result = await routeComplaintToAdmin(CTX("оператормен сөйлесейінші"), {
    summary: "Клиент операторга жалгагысы келедi",
    customerReply: "Бiр сатте",
    source: "ai_tool_escalate_to_admin",
  });
  assert.equal(result.action, "clarification_requested");
  assert.equal(result.caseId, null);
  assert.equal(result.customerReply, buildEscalationClarifyQuestion("human_request", "kk"));
});

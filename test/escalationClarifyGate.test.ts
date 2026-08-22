import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// No live redis in the test container: fail fast and do not let reconnect
// timers keep the process alive (same pattern as redisFailover.test.ts).
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const {
  buildEscalationClarifyQuestion,
  routeComplaintToAdmin,
} = await import("../src/services/complaintRouting.service.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

// 2026-08-21 live defect: case oc_1787323244566 was opened by the AI tool on a
// bare operator ask during smalltalk - the summary literally read
// "goal=smalltalk" - firing SOS to the panel and the site with nothing an
// operator could act on. The webhook lane had the clarify-first gate since
// 2026-08-20, but the tool calls routeComplaintToAdmin directly, before that
// gate. The gate now lives at the choke point itself.

const CTX = (text: string, language: "kk" | "ru" = "kk") =>
  ({ instanceId: "test-instance", phone: "77000000999", text, language, config: {} }) as any;

test("a bare operator demand via the AI tool earns the clarifying question, not a case", async () => {
  const result = await routeComplaintToAdmin(CTX("оператормен сөйлесейінші"), {
    summary: "Клиент операторга жалгагысы келедi",
    customerReply: "Бiр сатте",
    source: "ai_tool_escalate_to_admin",
  });
  assert.equal(result.action, "clarification_requested");
  assert.equal(result.caseId, null);
  assert.equal(result.queuedForChat, false);
  assert.equal(result.customerReply, buildEscalationClarifyQuestion("human_request", "kk"));
});

test("a bare complaint via the AI tool asks what happened first", async () => {
  const result = await routeComplaintToAdmin(CTX("у меня жалоба", "ru"), {
    summary: "Жалоба",
    source: "ai_tool_escalate_to_admin",
  });
  assert.equal(result.action, "clarification_requested");
  assert.equal(result.caseId, null);
  assert.equal(result.customerReply, buildEscalationClarifyQuestion("complaint", "ru"));
});

test("a complaint that already tells the story is never sent back for clarification", async () => {
  const result = await routeComplaintToAdmin(CTX("заказ привезли холодный и не тот соус положили", "ru"), {
    summary: "Холодный заказ, не тот соус",
    source: "ai_tool_escalate_to_admin",
  });
  // There is no Redis in this file by design, so the case cannot actually persist
  // and the honest action is escalation_failed (A1, 2026-08-22). What this test
  // guards is the gate: a self-describing story must go straight through it.
  assert.notEqual(result.action, "clarification_requested");
  assert.notEqual(result.action, "skipped_menu_question");
  assert.equal(result.action, "escalation_failed", "no Redis: the routing must admit the case was not recorded");
});

test("a cancellation request is self-describing and never earns the clarifying question", async () => {
  const result = await routeComplaintToAdmin(CTX("тапсырысымды болдырмағым келеді"), {
    summary: "Болдырмагым келедi",
    source: "ai_tool_escalate_to_admin",
  });
  assert.notEqual(result.action, "clarification_requested");
  assert.notEqual(result.action, "skipped_menu_question");
});

test("photo evidence escalates without the clarifying question", async () => {
  const result = await routeComplaintToAdmin(CTX("оператор"), {
    summary: "Фото далел",
    source: "ai_tool_escalate_to_admin",
    media: { base64: "aGVsbG8=", mimeType: "image/jpeg" },
  });
  assert.notEqual(result.action, "clarification_requested");
  assert.notEqual(result.action, "skipped_menu_question");
  assert.equal(result.mediaAttached, true, "the evidence must be carried into the case");
});

test("the other routing lanes are never gated twice", async () => {
  // The webhook text lane, the cancel flow and media analysis run their own
  // clarify/insistence logic before calling; only the bare AI tool source is
  // gated at the choke point.
  const result = await routeComplaintToAdmin(CTX("оператор керек"), {
    summary: "Оператор керек",
    source: "human_request",
  });
  assert.notEqual(result.action, "clarification_requested");
});

test("the webhook lane stands down when the escalate tool already ran this turn", async () => {
  const route = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  assert.match(route, /toolHandledEscalation/);
  assert.match(route, /needsClarification =\s+!toolHandledEscalation/);
  assert.match(route, /shouldRouteComplaint =\s+!toolHandledEscalation/);
  assert.match(route, /awaitingDetail = toolHandledEscalation \? null : await takeComplaintClarification/);
});

test("the site is notified once per case, not once per signal", async () => {
  const source = await readFile(new URL("../src/services/operatorCase.service.ts", import.meta.url), "utf8");
  assert.match(source, /sos_hub_sent:\$\{args\.instanceId\}:\$\{args\.caseId\}/);
  // A failed send releases the claim so the next signal of the case retries.
  assert.match(source, /redisClient\.del\(dedupeKey\)/);
});

test("the escalate tool tells the model what actually happened", async () => {
  const source = await readFile(new URL("../src/skills/escalation.skill.ts", import.meta.url), "utf8");
  assert.match(source, /action: routing\.action/);
  assert.match(source, /clarification_requested/);
});

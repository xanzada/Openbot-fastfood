import test from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { validateFinalText } = await import("../src/agent/finalValidator.js");
const { resolveAgentToolPlan } = await import("../src/agent/toolPolicy.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const BASE = (over: Record<string, any> = {}) => ({
  instanceId: "test-instance",
  phone: "77000000777",
  language: "kk" as const,
  config: {},
  text: "",
  activeOrder: null,
  runtimeStatus: { wait_time: 0, is_accepting_orders: true, within_work_hours: true },
  hardRealtimeContext: { wait_time: 0 },
  fetchedSettings: { wait_time: 0 },
  menuSnapshot: null,
  ...over,
}) as any;

// The validator's job is to cut what a live source did not authorise. Four ways it
// was cutting things that WERE authorised, all found on 2026-08-22 - each one turns
// a correct answer into a half answer, which reads to the guest as a broken bot.

// ---------------------------------------------------------------------------- A3
test("a status the checkOrderStatus tool just read is not deleted", () => {
  // preloadContext looks the order up by phone; the tool can find it by a quoted
  // number the phone lookup missed. ctx.activeOrder is then empty while the tool
  // has the real order in hand.
  const reply = "Тапсырысыңыз дайындалып жатыр, шамамен 15 минутта жеткіземіз.";
  const grounded = validateFinalText(reply, BASE(), { toolsCalled: ["checkOrderStatus"] });
  assert.match(grounded.text, /дайындалып/, "the verified status must survive");
  assert.ok(!grounded.warnings.includes("unsupported_order_claim_clause_removed"));

  // Without the tool and without an order, the invented status is still cut.
  const invented = validateFinalText(reply, BASE(), { toolsCalled: [] });
  assert.ok(
    invented.warnings.includes("unsupported_order_claim_clause_removed")
      || invented.warnings.includes("unsupported_order_claim"),
    `expected the ungrounded status to be cut, got ${JSON.stringify(invented.warnings)}`
  );
});

// ---------------------------------------------------------------------------- A4
test("a wait time getKitchenStatus re-read mid-turn is not deleted", () => {
  // getKitchenStatus calls the hub with forceFresh, so a wait raised AFTER preload
  // is real even though ctx.fetchedSettings still says 0.
  //
  // TWO sentences on purpose: both duration guards deliberately fail open when
  // nothing would survive (unsupported_wait_claim_only_sentence), so a
  // single-sentence fixture keeps its claim either way and proves nothing.
  const reply = "Сәлеметсіз бе. Дайындалуы шамамен 40 минут болады.";
  const grounded = validateFinalText(reply, BASE(), { toolsCalled: ["getKitchenStatus"] });
  assert.match(grounded.text, /40 минут/, "the freshly read wait must survive");
  assert.ok(!grounded.warnings.includes("unsupported_wait_claim_removed"));

  const ungrounded = validateFinalText(reply, BASE(), { toolsCalled: [] });
  assert.doesNotMatch(ungrounded.text, /40 минут/, "an ungrounded duration must be cut");
  assert.ok(ungrounded.warnings.includes("unsupported_wait_claim_removed"));
});

test("work hours from getBusinessInfo are not eaten by the duration guard", () => {
  // "24 сағат" is a work-hours fact, not a wait-time claim, but the duration regex
  // matched it and deleted the sentence.
  const reply = "Сәлеметсіз бе. Біз тәулік бойы 24 сағат жұмыс істейміз.";
  const grounded = validateFinalText(reply, BASE(), { toolsCalled: ["getBusinessInfo"] });
  assert.match(grounded.text, /24 сағат/, "a work-hours fact must survive");
  const ungrounded = validateFinalText(reply, BASE(), { toolsCalled: [] });
  assert.doesNotMatch(ungrounded.text, /24 сағат/, "without the tool the duration guard still applies");
});

// ---------------------------------------------------------------------------- A5
test("a price the menu snapshot authorised survives without a tool call", () => {
  // buildFactsPrompt's menu_snapshot.rule explicitly says a listed dish "can be
  // sold at the price shown". Requiring a tool on top deleted prices the prompt had
  // just told the model to quote - and MENU_LOOKUP_RE misses "Пицца почем?".
  // TWO sentences on purpose: the price guard fails open when nothing would survive
  // (ungrounded_price_claim_kept_no_survivor), so a single-sentence fixture keeps
  // its price either way and cannot tell the two cases apart.
  const ctx = BASE({ menuSnapshot: { count: 2, items: [{ name: "Пицца Маргарита", price: 2500 }] } });
  const reply = "Сәлеметсіз бе. Пицца Маргарита 2500 теңге тұрады.";
  const withSnapshot = validateFinalText(reply, ctx, { toolsCalled: [] });
  assert.match(withSnapshot.text, /2500/, "the authorised price must survive");
  assert.ok(!withSnapshot.warnings.includes("ungrounded_price_claim_removed"));

  // With no snapshot and no tool, an invented price is cut.
  const invented = validateFinalText(reply, BASE({ menuSnapshot: { count: 0, items: [] } }), { toolsCalled: [] });
  assert.doesNotMatch(invented.text, /2500/, "an ungrounded price must be cut");
  assert.ok(invented.warnings.includes("ungrounded_price_claim_removed"));
});

test("an allergen assurance is NOT relaxed by the snapshot - it still demands a tool", () => {
  // Telling a guest an allergen is absent is the one lie that can hospitalise them,
  // and a composition string is not a verified allergen statement. The snapshot
  // relaxation must not reach this guard.
  const ctx = BASE({ menuSnapshot: { count: 1, items: [{ name: "Салат", price: 1500, composition: "көкөніс" }] } });
  const reply = "Сәлеметсіз бе. Бұл тағамның құрамында жаңғақ жоқ.";
  const result = validateFinalText(reply, ctx, { toolsCalled: [] });
  assert.ok(result.warnings.includes("ungrounded_allergen_assurance_removed"),
    `an allergen assurance must never be snapshot-grounded, got ${JSON.stringify(result.warnings)}`);
  assert.doesNotMatch(result.text, /жаңғақ жоқ/);
});

test("an allergen assurance a menu lookup grounded is kept", () => {
  const ctx = BASE({ menuSnapshot: { count: 1, items: [{ name: "Салат", price: 1500 }] } });
  const reply = "Сәлеметсіз бе. Бұл тағамның құрамында жаңғақ жоқ.";
  const result = validateFinalText(reply, ctx, { toolsCalled: ["searchMenu"] });
  assert.ok(!result.warnings.includes("ungrounded_allergen_assurance_removed"));
  assert.match(result.text, /жаңғақ жоқ/, "a grounded assurance survives");
});

// ---------------------------------------------------------------------------- A7
test("the sentence telling the guest an operator will help is not deleted", () => {
  // The escalate tool's customerReply deliberately names the operator, and the
  // contract says to send it verbatim. Cutting every sentence containing the word
  // deleted exactly that sentence - and on a short reply collapsed the whole answer
  // to the generic fallback while a case had just been opened.
  const reply = "Кешіріңіз. Шағымды операторға жібердім, ол тексеріп сізбен байланысады.";
  const result = validateFinalText(reply, BASE(), { toolsCalled: ["escalateToAdmin"] });
  assert.match(result.text, /оператор/i, "the customer-safe operator sentence must survive");
  assert.ok(!result.warnings.includes("internal_disclosure_removed"));
});

test("provenance is still cut, including when it names the operator", () => {
  for (const reply of [
    "Оператордың ескертпесінде пицца жоқ деп жазылған.",
    "Жүйеде статуста дайын деп тұр.",
    "The kitchen_status note says it is closed.",
  ]) {
    const result = validateFinalText(`Сәлеметсіз бе. ${reply}`, BASE(), { toolsCalled: [] });
    assert.ok(result.warnings.includes("internal_disclosure_removed"),
      `provenance must be cut: ${reply} -> ${JSON.stringify(result.warnings)}`);
  }
});

// ---------------------------------------------------------------------------- A8
test("a closed kitchen is classified from runtimeStatus, not the partial object", () => {
  // hardRealtimeContext is always truthy and carries neither is_accepting_orders nor
  // within_work_hours, both of which the classifier defaults to TRUE. So a closed
  // kitchen was classified "normal", sendMenuLink got pinned, and the skill then
  // refused - the turn was spent on a refusal instead of the honest closed answer.
  const closed = resolveAgentToolPlan(BASE({
    text: "Тапсырыс берейін",
    explicitMenuLinkIntent: true,
    runtimeStatus: { wait_time: 0, is_accepting_orders: false, within_work_hours: false },
    hardRealtimeContext: { wait_time: 0 },
  }));
  assert.ok(!closed.requiredTools.includes("sendMenuLink"),
    `a closed kitchen must not pin the link, got ${JSON.stringify(closed.requiredTools)}`);

  const open = resolveAgentToolPlan(BASE({
    text: "Тапсырыс берейін",
    explicitMenuLinkIntent: true,
    runtimeStatus: { wait_time: 0, is_accepting_orders: true, within_work_hours: true },
    hardRealtimeContext: { wait_time: 0 },
  }));
  assert.ok(open.requiredTools.includes("sendMenuLink"), "an open kitchen still pins the link");
});

test("an emergency stop also blocks the link pin", () => {
  const emergency = resolveAgentToolPlan(BASE({
    text: "Заказать хочу",
    explicitMenuLinkIntent: true,
    runtimeStatus: { wait_time: 0, is_emergency: true, is_accepting_orders: true, within_work_hours: true },
  }));
  assert.ok(!emergency.requiredTools.includes("sendMenuLink"));
});

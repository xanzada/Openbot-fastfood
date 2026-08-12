import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hasExplicitMenuLinkIntent, wantsMenuAsText } from "../src/utils/magicLink.js";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { lastDiscussedOrderNumber, isUnownedOrderTimingQuestion } from "../src/utils/orderIntent.js";
import { isOrderCancellationRequest, detectOperatorCaseKind } from "../src/services/operatorCase.service.js";

// Live round 2026-08-12. Three separate turns where the personal menu link was
// sent instead of an answer, all traced back to the same intent regexes matching
// a word the guest used for the opposite purpose.

const ctx = (text: string) => ({ text, explicitMenuLinkIntent: false }) as any;

// "Я передумал, отмените мой заказ пожалуйста" was answered "Активный заказ по
// этому номеру не найден. Отправьте номер заказа" - the bot cannot cancel with or
// without that number, so the ask led nowhere.
test("a cancellation request is an operator case, not a status lookup", () => {
  for (const text of [
    "Я передумал, отмените мой заказ пожалуйста",
    "отмена заказа",
    "тапсырысымды болдырмаңыз",
    "заказ отменить хочу",
    "тапсырыстан бас тартқым келеді",
  ]) {
    assert.equal(isOrderCancellationRequest(text), true, text);
    assert.equal(detectOperatorCaseKind(text), "cancel_request", text);
  }
});

test("ordinary turns are not read as cancellations", () => {
  for (const text of ["хочу заказать", "мәзірді жіберіңіз", "заказ қашан жетеді", "я передумал, лучше пиццу"]) {
    assert.equal(isOrderCancellationRequest(text), false, text);
  }
});

test("the cancellation reply names the operator and never asks for the order number", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const start = source.indexOf("function cancellationHandoffReply");
  assert.ok(start > 0, "cancellationHandoffReply must exist");
  const body = source.slice(start, source.indexOf("\n}", start));
  assert.doesNotMatch(body, /Тапсырыс нөмірін жіберіңіз|Отправьте номер заказа/);
  assert.match(body, /операторға|оператору/iu);
  // It is settled before the status route, or that route answers first.
  assert.ok(
    source.indexOf("isOrderCancellationRequest(ctx.text)") < source.indexOf("await customerOrderReply(ctx)"),
    "the cancellation branch must run before the status route",
  );
  // And it raises a real operator case rather than replying into the void.
  const branch = source.slice(source.indexOf("if (isOrderCancellationRequest(ctx.text)) {"));
  assert.match(branch.slice(0, 900), /routeComplaintToAdmin\(ctx, \{[\s\S]*source: "cancel_request"/);
});



test("declining the link and asking for the menu in writing is not a link request", () => {
  for (const text of [
    "Сілтемені ашқым жоқ, жазып жіберіңіз мәзірді",
    "Ссылку не хочу, напишите меню здесь",
    "меню без ссылки перечислите пожалуйста",
  ]) {
    assert.equal(wantsMenuAsText(text), true, text);
    assert.equal(hasExplicitMenuLinkIntent(text), false, text);
  }
});

test("a plain request for the menu link still gets one", () => {
  for (const text of ["Мәзір сілтемесін жіберіңіз", "меню скинь", "хочу заказать"]) {
    assert.equal(wantsMenuAsText(text), false, text);
    assert.equal(hasExplicitMenuLinkIntent(text), true, text);
  }
});

test("a menu-in-writing request asks for searchMenu and suppresses the link tool", () => {
  const plan = resolveAgentToolPlan(ctx("Сілтемені ашқым жоқ, жазып жіберіңіз мәзірді"));
  assert.ok(plan.requiredTools.includes("searchMenu"), JSON.stringify(plan));
  assert.ok(!plan.requiredTools.includes("sendMenuLink"), JSON.stringify(plan));
});

// The worst reply of the round: a refund demand answered with nothing but a URL.
test("an actionable complaint escalates and is never given the menu link", () => {
  const plan = resolveAgentToolPlan(
    ctx("Вы что издеваетесь?! Я заказ сделал час назад, до сих пор ничего не привезли. Верните деньги немедленно!"),
  );
  assert.ok(plan.requiredTools.includes("escalateToAdmin"), JSON.stringify(plan));
  assert.ok(!plan.requiredTools.includes("sendMenuLink"), JSON.stringify(plan));
});

// Even when the context flag arrives true from an older code path, a complaint
// turn must not acquire the link tool.
test("the context link flag does not override a complaint", () => {
  const plan = resolveAgentToolPlan({
    text: "Роллы были холодные, заказ сделал час назад, верните деньги",
    explicitMenuLinkIntent: true,
  } as any);
  assert.ok(!plan.requiredTools.includes("sendMenuLink"), JSON.stringify(plan));
});

// Our own "not found" line is a sentence about an order that does not exist.
test("a not-found reply does not become the order under discussion", () => {
  assert.equal(
    lastDiscussedOrderNumber([
      { role: "assistant", text: "№019 тапсырысы осы нөмір бойынша табылмады." },
    ]),
    "",
  );
  assert.equal(
    lastDiscussedOrderNumber([{ role: "assistant", text: "Заказ №019 не найден по этому номеру." }]),
    "",
  );
});

test("a real status line is still the order under discussion", () => {
  assert.equal(
    lastDiscussedOrderNumber([{ role: "assistant", text: "Тапсырыс №019 дайындалып жатыр." }]),
    "019",
  );
});

test("an order named long ago stops being the one in play", () => {
  const history: any[] = [{ role: "assistant", text: "Тапсырыс №019 дайындалып жатыр." }];
  for (let index = 0; index < 7; index += 1) {
    history.push({ role: "user", text: "тағы не бар?" });
    history.push({ role: "assistant", text: "Цезарь 3000 теңге." });
  }
  assert.equal(lastDiscussedOrderNumber(history), "");
});

// A guest who calls it "my order" is asking about an order, not about the
// kitchen. Standing down here answered "we cook without delays" to someone who
// believed they were waiting for food.
test("claiming an order keeps the status route even with timing words", () => {
  for (const text of [
    "Менің тапсырысым қайда? Қашан жетеді?",
    "мой заказ когда привезут",
    "заказым қашан дайын болады",
  ]) {
    assert.equal(isUnownedOrderTimingQuestion({ text, hasActiveOrder: false }), false, text);
  }
});

test("a general kitchen timing question still stands down for the prep-time answer", () => {
  for (const text of [
    "Дайындалуы қанша уақыт алады?",
    "заказ берсем қанша уақытта жетеді",
    "сколько по времени готовите",
  ]) {
    assert.equal(isUnownedOrderTimingQuestion({ text, hasActiveOrder: false }), true, text);
  }
});

// The SOS card in the operator panel showed our own apology back to the guest,
// so the operator had to open the chat to learn what the complaint was.
test("the operator case is summarised with the guest's words, not our reply", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const call = source.slice(source.indexOf("if (shouldRouteComplaint) {"));
  const summaryLine = call.slice(call.indexOf("summary:"), call.indexOf("customerText:"));
  assert.match(summaryLine, /stripEscalationSignals\(ctx\.text\)/);
  // The AI text may only be the fallback, never the preferred half.
  assert.ok(
    summaryLine.indexOf("ctx.text") < summaryLine.indexOf("rawAiText"),
    `guest text must be preferred over the AI line: ${summaryLine}`,
  );
});

// A video, an unreadable file and a rejected receipt all returned before the
// inbound message was written to history, so the next turn saw our own refusal
// with nothing before it and the guest had to explain themselves twice.
test("the inbound turn is recorded before any early exit can return", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const recorded = source.indexOf("await recordInboundTurn();");
  assert.ok(recorded > 0, "recordInboundTurn must be called");
  assert.ok(recorded < source.indexOf('mediaContext?.kind === "video"'), "it must run before the video exit");
  assert.ok(recorded < source.indexOf("if (mediaContext && !mediaContext.valid)"), "and before the invalid-media exit");
  // Guarded so the later call on the normal path cannot double-write the turn.
  assert.match(source, /if \(inboundRecorded\) return;\s*\n\s*inboundRecorded = true;/);
  // The video refusal goes through the shared sender, so it lands in history too.
  assert.match(source, /sendCustomerReplyAndFinish\(ctx, messageId, reply, "media_rejected:video"\)/);
});

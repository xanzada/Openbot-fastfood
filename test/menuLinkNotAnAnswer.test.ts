import test from "node:test";
import assert from "node:assert/strict";
import { hasExplicitMenuLinkIntent, wantsMenuAsText } from "../src/utils/magicLink.js";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { lastDiscussedOrderNumber } from "../src/utils/orderIntent.js";

// Live round 2026-08-12. Three separate turns where the personal menu link was
// sent instead of an answer, all traced back to the same intent regexes matching
// a word the guest used for the opposite purpose.

const ctx = (text: string) => ({ text, explicitMenuLinkIntent: false }) as any;

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

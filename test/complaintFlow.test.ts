import test from "node:test";
import assert from "node:assert/strict";
import {
  complaintHasActionableDetail,
  isLikelyComplaintText,
  isLikelyOperatorRequestText,
  buildComplaintDetailQuestion,
  buildEscalationClarifyQuestion,
  buildOperatorHandoffReply,
} from "../src/services/complaintRouting.service.js";
import { detectOperatorCaseKind } from "../src/services/operatorCase.service.js";
import { isLikelyMenuQuestion } from "../src/utils/intentText.js";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";

test("asking for a human is recognised and never mistaken for a complaint to investigate", () => {
  for (const text of ["оператор шақырыңыз", "адаммен сөйлескім келеді", "позовите оператора", "соедините с менеджером"]) {
    assert.equal(isLikelyOperatorRequestText(text), true, text);
  }
});

test("a courier number request is recognised - and earns one question before any SOS", () => {
  // The courier phone is never in any config and must never be invented, but a
  // bare ask no longer fires SOS on its own: the guest is asked what happened
  // first, and the case is created from their answer (2026-08-20).
  for (const text of ["курьердің номерін беріңізші", "номер курьера дайте", "курьерге хабарласайын"]) {
    assert.equal(isLikelyOperatorRequestText(text), true, text);
    assert.equal(detectOperatorCaseKind(text), "courier_request", text);
  }
});

test("the operator case knows which kind of help was asked for", () => {
  assert.equal(detectOperatorCaseKind("оператор керек"), "human_request");
  assert.equal(detectOperatorCaseKind("тапсырыс суық келді, сапасы нашар"), "complaint");
  assert.equal(detectOperatorCaseKind("пицца қанша тұрады"), null, "an ordinary question is not a case");
});

test("a complaint that already names the problem goes straight to the operator", () => {
  const detailed = "Тапсырысым суық келді, пицца жабысып қалған, 42 нөмірлі заказ";
  assert.equal(isLikelyComplaintText(detailed), true);
  assert.equal(complaintHasActionableDetail(detailed), true, "there is something an operator can act on");
});

test("an explicit late-order incident escalates before any status lookup", () => {
  for (const text of ["Заказ опоздал на час", "Тапсырыс бір сағатқа кешікті"]) {
    assert.equal(isLikelyComplaintText(text), true, text);
    assert.equal(complaintHasActionableDetail(text), true, text);
    const plan = resolveAgentToolPlan({ text } as any);
    assert.equal(plan.requiredTools[0], "escalateToAdmin", text);
    assert.equal(plan.requiredTools.includes("checkOrderStatus"), false, text);
  }
});

test("a bare complaint earns one question first", () => {
  for (const text of ["шағым бар", "жалоба", "сапасы нашар"]) {
    assert.equal(isLikelyComplaintText(text), true, text);
    assert.equal(complaintHasActionableDetail(text), false, `${text} names nothing yet`);
  }
});

test("the detail threshold counts real words, not punctuation", () => {
  assert.equal(complaintHasActionableDetail("не то. не то. не то."), false, "repetition is not detail");
  assert.equal(
    complaintHasActionableDetail("заказ привезли холодный и не тот соус положили"),
    true,
    "six meaningful words describe something"
  );
  assert.equal(
    complaintHasActionableDetail("а".repeat(70)),
    true,
    "a long message is treated as detail even without word breaks"
  );
});

test("both customer-facing lines stay short and promise nothing", () => {
  for (const lang of ["kk", "ru"] as const) {
    const question = buildComplaintDetailQuestion(lang);
    const handoff = buildOperatorHandoffReply(lang);
    for (const line of [question, handoff]) {
      assert.ok(line.length > 0 && line.length < 120, `${lang}: "${line}" must be one short line`);
      assert.doesNotMatch(line, /скидк|бонус|верн|қайтар|жеңілдік/i, "no promise of refunds or discounts");
    }
    assert.match(handoff, /оператор/i, `${lang} handoff must name the operator`);
  }
});

test("anger about a specific order is a complaint, not a status question", () => {
  // A guest who names an order number while furious used to receive a dry
  // status line, and the operator never saw a red flag. The complaint signal
  // has to win over the order-number signal.
  for (const text of [
    "вы что творите вообще, заказ 59 холодный привезли и цезарь кислый, это ужас требую возврат",
    "59 тапсырысым суық келді, сапасы нашар, ақшамды қайтарыңыз",
  ]) {
    assert.equal(isLikelyComplaintText(text), true, text);
  }
});

test("asking about shashlik is a menu question, not a hair complaint", () => {
  // "шашлык" contains "шаш" (hair): a bare substring match opened a red SOS
  // case for a guest asking whether shashlik is on the menu (live, 2026-08-20).
  for (const text of ["Шашлык бар ма?", "шашлык қанша тұрады", "можно два шашлыка"]) {
    assert.equal(isLikelyComplaintText(text), false, text);
    assert.equal(detectOperatorCaseKind(text), null, text);
  }
  assert.equal(isLikelyComplaintText("тапсырыста шаш таптым"), true, "a real hair report still matches");
  assert.equal(detectOperatorCaseKind("пиццада шаш бар екен"), "complaint", "a real hair complaint still escalates");
});

test("clarify-first questions are short, kind-aware and promise nothing", () => {
  for (const lang of ["kk", "ru"] as const) {
    for (const kind of ["human_request", "courier_request", "complaint"] as const) {
      const line = buildEscalationClarifyQuestion(kind, lang);
      assert.ok(line.length > 0 && line.length < 200, `${lang}/${kind}: "${line}" must be one short line`);
      assert.doesNotMatch(line, /скидк|бонус|верн|қайтар|жеңілдік/i, "no promise of refunds or discounts");
    }
    assert.match(buildEscalationClarifyQuestion("courier_request", lang), /курьер/i, "courier question names the courier");
  }
});

test("no menu or off-menu question can ever raise a complaint lane", () => {
  // Live rule (2026-08-20): not just шашлык - ANY availability/price/menu ask
  // must stay out of SOS entirely. The bot answers it from the menu instead.
  for (const text of [
    "Шашлык бар ма?",
    "Суық суы бар ма?",
    "Кока-кола бар ма",
    "пицца қанша тұрады",
    "есть ли суши в наличии",
    "сапасы қандай болады?",
    "мәзірде не бар",
    "можно два шашлыка",
    "классная пицца была вчера, спасибо",
  ]) {
    assert.equal(isLikelyComplaintText(text) && !isLikelyMenuQuestion(text), false, text);
    assert.equal(detectOperatorCaseKind(text), null, text);
  }
});

test("genuine incidents still reach the complaint lane past the menu guard", () => {
  for (const text of [
    "Тапсырысым суық келді, пицца жабысып қалған",
    "суда шаш таптым, шағым",
    "заказ не привезли вовсе",
    "қорабы лас еді, іше алмаймыз",
  ]) {
    assert.equal(isLikelyComplaintText(text) && !isLikelyMenuQuestion(text), true, text);
  }
  assert.equal(detectOperatorCaseKind("суда шаш таптым"), "complaint");
  assert.equal(detectOperatorCaseKind("қорабым лас келді"), "complaint");
});

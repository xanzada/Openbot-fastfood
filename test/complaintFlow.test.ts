import test from "node:test";
import assert from "node:assert/strict";
import {
  complaintHasActionableDetail,
  isLikelyComplaintText,
  isLikelyOperatorRequestText,
  buildComplaintDetailQuestion,
  buildOperatorHandoffReply,
} from "../src/services/complaintRouting.service.js";

test("asking for a human is recognised and never mistaken for a complaint to investigate", () => {
  for (const text of ["оператор шақырыңыз", "адаммен сөйлескім келеді", "позовите оператора", "соедините с менеджером"]) {
    assert.equal(isLikelyOperatorRequestText(text), true, text);
  }
});

test("a complaint that already names the problem goes straight to the operator", () => {
  const detailed = "Тапсырысым суық келді, пицца жабысып қалған, 42 нөмірлі заказ";
  assert.equal(isLikelyComplaintText(detailed), true);
  assert.equal(complaintHasActionableDetail(detailed), true, "there is something an operator can act on");
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

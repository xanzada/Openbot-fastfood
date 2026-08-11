import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isUnownedOrderTimingQuestion } from "../src/utils/orderIntent.js";

// Live round on 2026-08-11: a guest who had never ordered asked how long the
// food takes and was answered "no active order on this number, send the order
// number". The sentence matches the status patterns ("тапсырыс ... дайын"), so
// the status route claimed it. With nothing to look up, it must stand down.
test("a timing question with no order in play stands down from the status route", () => {
  const asked = [
    "Қанша уақыт күтемін, тапсырыс дайын болуы қанша минут?",
    "қанша уақытта жетеді?",
    "через сколько привезете",
    "как долго ждать",
    "қазір заказ берсем қанша уақытта дайын болады",
  ];
  for (const text of asked) {
    assert.equal(isUnownedOrderTimingQuestion({ text, hasActiveOrder: false }), true, text);
  }
});

test("the same question about a real order keeps the deterministic status line", () => {
  const text = "қанша уақытта жетеді?";
  assert.equal(isUnownedOrderTimingQuestion({ text, hasActiveOrder: true }), false);
  assert.equal(isUnownedOrderTimingQuestion({ text, hasActiveOrder: false, quotedOrderNumber: "13" }), false);
  assert.equal(isUnownedOrderTimingQuestion({ text, hasActiveOrder: false, discussedOrderNumber: "13" }), false);
});

test("a plain status question never stands down - it still gets the honest miss", () => {
  assert.equal(
    isUnownedOrderTimingQuestion({ text: "менде тапсырыс бар ма", hasActiveOrder: false }),
    false
  );
  assert.equal(isUnownedOrderTimingQuestion({ text: "мәзірде не бар", hasActiveOrder: false }), false);
});

// Second live defect: the guest wrote "№13" and the bot answered "send the
// order number" - as if the message had not been read.
test("a quoted order number that cannot be found is named back, not asked for again", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  assert.match(source, /function missingQuotedOrderReply/);
  assert.match(source, /referenced \? missingQuotedOrderReply\(ctx\.language, referenced\) : missingOrderReply\(ctx\.language\)/);
  assert.match(source, /const referenced = orderNumber \|\| discussedNumber/);
  // The quoted-number reply must not repeat the "send the order number" ask.
  const quoted = source.slice(source.indexOf("function missingQuotedOrderReply"));
  const body = quoted.slice(0, quoted.indexOf("\n}"));
  assert.doesNotMatch(body, /Тапсырыс нөмірін жіберіңіз|Отправьте номер заказа/);
  assert.match(body, /\$\{orderNumber\}/);
});

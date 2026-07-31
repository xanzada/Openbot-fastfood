import test from "node:test";
import assert from "node:assert/strict";
import { isOrderTimingQuestion } from "../src/utils/orderIntent.js";

test("a guest asking how long the food takes is a timing question", () => {
  assert.equal(isOrderTimingQuestion("қанша уақытта жетеді?"), true);
  assert.equal(isOrderTimingQuestion("kansha uakytta jetedi"), true);
  assert.equal(isOrderTimingQuestion("через сколько привезете"), true);
  assert.equal(isOrderTimingQuestion("как долго ждать"), true);
});

test("ordinary menu talk is not a timing question", () => {
  assert.equal(isOrderTimingQuestion("мәзірде не бар"), false);
  assert.equal(isOrderTimingQuestion("цезарь қанша тұрады"), false);
});

import { orderNextStepLine } from "../src/services/customerOrder.service.js";

function order(label: string) {
  return { orderNumber: "59", status: "paid", stage: "cooking", statusLabel: label, statusExplanation: "", items: [] } as any;
}

test("food still on the stove is never announced as ready for pickup", () => {
  assert.equal(orderNextStepLine(order("Дайындалуда"), "kk"), "Дайын болған сәтте бірден хабарлаймыз.");
  assert.equal(orderNextStepLine(order("Готовится"), "ru"), "Как только будет готово, сразу напишем.");
});

test("a genuinely ready order invites the guest to collect it", () => {
  assert.equal(orderNextStepLine(order("Дайын"), "kk"), "Алып кетуге болады — бәрі дайын.");
  assert.equal(orderNextStepLine(order("Жолда"), "kk"), "Курьер жолға шықты.");
});

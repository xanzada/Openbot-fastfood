import test from "node:test";
import assert from "node:assert/strict";
import { isLikelyOrderStatusFollowUp, isOrderTimingQuestion } from "../src/utils/orderIntent.js";

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


test("a guest reading the menu is not asking about a waiting order", () => {
  assert.equal(isLikelyOrderStatusFollowUp("слушай а че там у вас из суши есть и почем самый дешевый"), false);
  assert.equal(isLikelyOrderStatusFollowUp("мәзірде не бар, қанша тұрады"), false);
});

test("a guest waiting for food still reaches the status route", () => {
  assert.equal(isLikelyOrderStatusFollowUp("че там брат заказ дайын болдыма"), true);
  assert.equal(isLikelyOrderStatusFollowUp("курьер қайда"), true);
});

test("a priced menu question that names an order number still gets the status", () => {
  assert.equal(isLikelyOrderStatusFollowUp("заказ 59 дайын ба, почем вышло"), true);
});

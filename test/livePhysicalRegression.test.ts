import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildBlockedMenuItemReply,
  buildUnverifiedPaymentClaimReply,
  findBlockedMenuItemMention,
  isUnverifiedPaymentClaim,
} from "../src/services/operationalPreemption.service.js";
import {
  isLikelyOrderStatusFollowUp,
  isProspectiveOrderTimingQuestion,
} from "../src/utils/orderIntent.js";
import { classifyKitchenSalesPolicy } from "../src/services/kitchenPolicy.service.js";

test("live: a new-order ETA question is not hijacked by an older active order", () => {
  assert.equal(
    isProspectiveOrderTimingQuestion("казир заказ берсем канша кутем, доставка кашан келед?"),
    true,
  );
  assert.equal(
    isProspectiveOrderTimingQuestion("58 заказым кашан дайын болады?"),
    false,
  );
});

test("live: a compound availability plus ordering phrase obeys the active note", () => {
  const item = findBlockedMenuItemMention(
    [{ noteId: "e2e-1", text: "Футомаки временно нет" }],
    [{ name: "Футомаки", price: 2300, category: "Суши", composition: "" }],
    "ал енди футомаки барма, заказ бере аламба?",
  );

  assert.equal(item?.name, "Футомаки");
  const reply = buildBlockedMenuItemReply(item!, "kk");
  assert.match(reply, /уақытша қолжетімсіз/u);
  assert.doesNotMatch(reply, /https?:\/\/|prestige\.bekaba\.com/iu);
});

test("live: a text-only payment claim asks for proof and never claims paid", () => {
  const text = "60 заказга 1000 тг аудардым, paid кылып жбер";
  assert.equal(isUnverifiedPaymentClaim(text), true);
  assert.equal(isUnverifiedPaymentClaim("каспиге кай номерге аударам?"), false);

  const reply = buildUnverifiedPaymentClaimReply("kk");
  assert.match(reply, /чек|скрин/iu);
  assert.match(reply, /оператор/iu);
  assert.doesNotMatch(reply, /төлем (?:расталды|қабылданды)|\bpaid\b|https?:\/\//iu);
});

test("live guards execute before order-status and the LLM path", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const guard = source.indexOf("operationalPreemptionReply(ctx)");
  const status = source.indexOf("customerOrderReply(ctx)", guard);
  const agent = source.indexOf("runFastFoodAgent(ctx)", guard);

  assert.ok(guard >= 0, "physical-test guard must be wired into the webhook");
  assert.ok(status > guard, "payment/note truth must outrank an older order status");
  assert.ok(agent > guard, "deterministic live-state guards must save the AI call");
});

test("live: active-order shorthand keeps the current order context", () => {
  for (const phrase of ["че там брат", "не болды", "ал не жаңалық", "ну и?"]) {
    assert.equal(isLikelyOrderStatusFollowUp(phrase), true, phrase);
  }
});

test("live: a dish becoming unavailable while it is already in the cart preempts checkout talk", () => {
  const item = findBlockedMenuItemMention(
    [{ noteId: "e2e-mid-cart", text: "Донер временно нет" }],
    [{
      name: "Донер (или донер-кебаб)",
      price: 1000,
      category: "Донер",
      composition: "мясо, лаваш, овощи, соус",
    }],
    "ағасы корзинада донер тұр, ала берейін ба?",
  );

  assert.equal(item?.name, "Донер (или донер-кебаб)");
  assert.doesNotMatch(buildBlockedMenuItemReply(item!, "kk"), /https?:\/\/|prestige\.bekaba\.com/iu);
});

test("live: two hours requires consent while four hours closes new sales", () => {
  const base = { delivery: true, pickup: true, is_emergency: false, reset_at: 0 };
  const twoHours = classifyKitchenSalesPolicy({ kitchen_status: { ...base, wait_time: 120 } });
  const fourHours = classifyKitchenSalesPolicy({ kitchen_status: { ...base, wait_time: 240 } });

  assert.equal(twoHours.mode, "busy");
  assert.equal(twoHours.requiresConsent, true);
  assert.equal(twoHours.blocksAllSales, false);
  assert.equal(fourHours.mode, "critical");
  assert.equal(fourHours.blocksAllSales, true);
});

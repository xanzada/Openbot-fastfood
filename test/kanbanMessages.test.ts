import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLegacyNewOrderMessage,
  buildLegacyRejectedMessage,
  formatLegacyPaymentMessage,
  legacyStatusTemplates,
  orderNotifyRank,
  parsePickupFlag,
  resolveStatusCustomerMessage,
} from "../src/controllers/kanban.js";

test("new_order message preserves Kazakh UTF-8 and order details", () => {
  const text = buildLegacyNewOrderMessage({
    total_price: 6600,
    comment: "[Списано 400Б] | Приборы: 2 шт",
    items: [{ name: "Кальцоне", qty: 2, price: 3500 }],
  }, "kk", "35", true);

  assert.equal(text, [
    "🛍 *№35 тапсырысыңыз қабылданды!*",
    "🏃 *Түрі:* Алып кету (Самовывоз)",
    "🎁 *Жұмсалған бонус:* 400 ₸",
    "🍴 *Адам саны:* 2",
    "",
    "🛒 *Тапсырыс құрамы:*",
    "▪️ Кальцоне x2 = 7000 ₸",
    "➖➖➖➖➖➖➖",
    "💰 *БАРЛЫҒЫ: 6600 ₸*",
    "➖➖➖➖➖➖➖",
    "",
    "⏳ *Назарыңызға:* Біз ас үйде бар-жоғын тексеріп жатырмыз, 1-2 минут күте тұрыңыз...",
  ].join("\n"));
  assert.doesNotMatch(text, /(?:Рџ|РЎ|вЏ|вњ|РµР)/);
});

test("payment, rejection and lifecycle templates remain valid UTF-8", () => {
  assert.equal(formatLegacyPaymentMessage("6600", "Kaspi: +77764846565\nHalyk: +77745456456", "kk"), [
    "✅ *Бәрі бар!*",
    "💰 Төлем сомасы: *6600 ₸*",
    "",
    "💳 *Төлем жасау:*",
    "Kaspi: +77764846565",
    "Halyk: +77745456456",
    "",
    "🧾 *Төлем жасағаннан кейін чекті осы чатқа жіберіңіз 👇*",
  ].join("\n"));
  assert.equal(legacyStatusTemplates.kk.paid, "✅ Төлем расталды, тапсырысыңыз қабылданды. Дайындалуда! 🍳");
  assert.equal(legacyStatusTemplates.kk.delivery, "✅ Тапсырысыңыз дайын және курьерге берілді. Қазір сізге қарай жолда 🛵");
  assert.equal(legacyStatusTemplates.kk.completed, "🎉 Тапсырыс сәтті аяқталды, асыңыз дәмді болсын!");
  assert.match(buildLegacyRejectedMessage({ reason: "Тағам жоқ" }, "kk"), /Тағам жоқ/);
});

test("delivery handoff sends one combined bilingual update instead of ready plus courier duplicates", () => {
  // Delivery orders must stay silent at the intermediate kitchen-ready step.
  // The courier handoff then communicates both facts in one human message.
  assert.equal(resolveStatusCustomerMessage("ready", false, "kk"), "");
  assert.equal(
    resolveStatusCustomerMessage("delivery", false, "kk"),
    "✅ Тапсырысыңыз дайын және курьерге берілді. Қазір сізге қарай жолда 🛵",
  );
  assert.equal(resolveStatusCustomerMessage("ready", false, "ru"), "");
  assert.equal(
    resolveStatusCustomerMessage("delivery", false, "ru"),
    "✅ Ваш заказ готов и передан курьеру. Он уже едет к вам 🛵",
  );

  // Pickup has no courier transition, so its useful ready notification remains.
  assert.equal(resolveStatusCustomerMessage("ready", true, "kk"), "✅ Тапсырысыңыз дайын! Келіп алып кетуіңізге болады.");
  assert.equal(resolveStatusCustomerMessage("ready", true, "ru"), "✅ Ваш заказ готов! Можете забирать.");
});

test("delivery order shows localized fee below the comment and removes the raw marker", () => {
  const free = buildLegacyNewOrderMessage({
    total_price: 8200,
    address: "Брусиловского 18",
    comment: "[Доставка 0т] Тегін не бар",
    items: [{ name: "Пицца", qty: 1, price: 8200 }],
  }, "kk", "37", false);
  assert.match(free, /💬 \*Пікір:\* Тегін не бар\n🚚 \*Жеткізу:\* Тегін/);
  assert.doesNotMatch(free, /\[Доставка/);

  const paid = buildLegacyNewOrderMessage({
    total_price: 8800,
    delivery_fee: 600,
    comment: "Позвонить заранее",
    items: [{ name: "Пицца", qty: 1, price: 8200 }],
  }, "ru", "38", false);
  assert.match(paid, /💬 \*Комментарий:\* Позвонить заранее\n🚚 \*Доставка:\* 600 ₸/);
});

// The site sends the real delivery fee when it charges one and an explicit free
// marker above the threshold; with no field at all the bot must not invent
// "Тегін" (live, 2026-08-14).
test("the delivery line shows the site's real fee, says free only on an explicit marker, and never invents free", () => {
  const feeMsg = buildLegacyNewOrderMessage({ total_price: 5200, delivery_price: 500, items: [{ name: "Pizza", qty: 1, price: 5200 }] }, "kk", "1", false);
  assert.match(feeMsg, /Жеткізу:\* 500 ₸/u);

  const freeMsg = buildLegacyNewOrderMessage({ total_price: 9000, delivery_price: 0, items: [{ name: "Pizza", qty: 1, price: 9000 }] }, "kk", "1", false);
  assert.match(freeMsg, /Жеткізу:\* Тегін/u);

  const freeWordMsg = buildLegacyNewOrderMessage({ total_price: 9000, delivery_price: "тегін", items: [{ name: "Pizza", qty: 1, price: 9000 }] }, "kk", "1", false);
  assert.match(freeWordMsg, /Жеткізу:\* Тегін/u);

  const unknownMsg = buildLegacyNewOrderMessage({ total_price: 5200, items: [{ name: "Pizza", qty: 1, price: 5200 }] }, "kk", "1", false);
  assert.match(unknownMsg, /Жеткізу:\* сайтта есептеледі/u);
  assert.doesNotMatch(unknownMsg, /Жеткізу:\* Тегін/u);
});

test("a stale replay never moves the guest backwards and a cancel blocks late payment asks", () => {
  assert.ok(orderNotifyRank("status_changed", "ready_delivery") < orderNotifyRank("status_changed", "delivery"));
  assert.ok(orderNotifyRank("request_payment") < orderNotifyRank("order_rejected"));
  assert.ok(orderNotifyRank("new_order") < orderNotifyRank("status_changed", "paid"));
  assert.equal(orderNotifyRank("status_changed", "pickup_ready"), orderNotifyRank("status_changed", "ready_delivery"));
  assert.equal(orderNotifyRank("status_changed", "mystery_status"), -1);
});

test("pickup order shows no address and no delivery line; the delivery fee is exact", () => {
  const pickup = buildLegacyNewOrderMessage({ total_price: 5000, delivery_price: 0, items: [{ name: "Ролл", qty: 1, price: 5000 }] }, "kk", "40", true);
  assert.match(pickup, /Алып кету/);
  assert.doesNotMatch(pickup, /Мекенжай/);
  assert.doesNotMatch(pickup, /Жеткізу/);

  const free = buildLegacyNewOrderMessage({ total_price: 9000, address: "Абая 10", delivery_price: 0, items: [{ name: "Ролл", qty: 1, price: 9000 }] }, "kk", "41", false);
  assert.match(free, /🚚 \*Жеткізу:\* Тегін/);

  const paid = buildLegacyNewOrderMessage({ total_price: 7000, address: "Абая 10", delivery_price: 1000, items: [{ name: "Ролл", qty: 1, price: 6000 }] }, "kk", "42", false);
  assert.match(paid, /🚚 \*Жеткізу:\* 1000 ₸/);
});

test("fulfillment_type words map to the pickup flag and the cancel note offers the menu", () => {
  assert.equal(parsePickupFlag("pickup"), true);
  assert.equal(parsePickupFlag("delivery"), false);
  assert.equal(parsePickupFlag("самовывоз"), true);
  assert.equal(parsePickupFlag(true), true);
  assert.equal(parsePickupFlag(false), false);
  assert.equal(parsePickupFlag(undefined), false);
  assert.match(buildLegacyRejectedMessage({ reason: "Тағам бітіп қалды" }, "kk"), /[Мм]әзір/);
  assert.match(buildLegacyRejectedMessage({ reason: "Тағам бітіп қалды" }, "kk"), /Тағам бітіп қалды/);
  assert.match(buildLegacyRejectedMessage({}, "ru"), /меню/);
});

test("a spent bonus shows as its own line in the order message", () => {
  const msg = buildLegacyNewOrderMessage({ total_price: 6500, delivery_price: 1000, bonus: 500, address: "Абая 10", items: [{ name: "Ролл", qty: 2, price: 3000 }] }, "kk", "22", false);
  assert.match(msg, /🎁 \*Жұмсалған бонус:\* 500 ₸/);
  assert.match(msg, /БАРЛЫҒЫ: 6500 ₸/);
});

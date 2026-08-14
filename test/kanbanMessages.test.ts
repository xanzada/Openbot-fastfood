import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLegacyNewOrderMessage,
  buildLegacyRejectedMessage,
  formatLegacyPaymentMessage,
  legacyStatusTemplates,
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
  assert.equal(legacyStatusTemplates.kk.delivery, "🛵 Тапсырысыңыз курьерге берілді, жеткізу жолында.");
  assert.equal(legacyStatusTemplates.kk.completed, "🎉 Тапсырыс сәтті аяқталды, асыңыз дәмді болсын!");
  assert.match(buildLegacyRejectedMessage({ reason: "Тағам жоқ" }, "kk"), /Тағам жоқ/);
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

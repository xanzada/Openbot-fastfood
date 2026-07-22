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

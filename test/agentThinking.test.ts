import test from "node:test";
import assert from "node:assert/strict";
import { shouldThink } from "../src/services/agentThinking.service.js";

function ctx(text: string, mediaContext: any = null) {
  return { text, mediaContext } as any;
}

test("trivial turns never pay for a think call", () => {
  for (const text of [
    "Сәлем",
    "привет",
    "рахмет!",
    "спасибо",
    "жарайды",
    "ок",
    "иә",
    "да",
    "қош",
    "👍",
  ]) {
    assert.equal(shouldThink(ctx(text)), false, text);
  }
});

test("money, orders and complaints always earn the pre-pass", () => {
  for (const text of [
    "заказ келмеді, не істейін?",
    "мой заказ опаздывает уже час",
    "төлемді төледім, чек жібердім",
    "я оплатил, куда чек отправить",
    "шағымым бар, тамақ суық келді",
    "хочу вернуть деньги за заказ",
    "оператор шақырыңызшы",
  ]) {
    assert.equal(shouldThink(ctx(text)), true, text);
  }
});

test("long or multi-question turns are thought-worthy", () => {
  assert.equal(shouldThink(ctx("Пицца бар ма, канша турады, жеткизу қанша уақыт алады?")), true);
  assert.equal(
    shouldThink(ctx("Кешіріңіз, кеше тапсырыс берген едім, бүгін тағы сұрайын деп едім: жинағыңыздағы пиццалардың қайсысы ең дәмді және олардың бағасы қанша болады, сондай-ақ жеткізу қанша уақытта келеді деген сұрақ та бар еді?")),
    true
  );
  assert.equal(shouldThink(ctx("Не боп болып жатыр?! Тағы да кешікті!!")), true);
});

test("one neutral question does not pay for a think call but two questions do", () => {
  assert.equal(shouldThink(ctx("Can you help?")), false);
  assert.equal(shouldThink(ctx("Can you help? What is next?")), true);
});

test("media turns get analysis because captions are rarely self-explanatory", () => {
  assert.equal(shouldThink(ctx("мынау не?", { kind: "photo" })), true);
});

test("empty text is never analysed", () => {
  assert.equal(shouldThink(ctx("")), false);
});

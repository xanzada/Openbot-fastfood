import test from "node:test";
import assert from "node:assert/strict";
import { mergePartsDeterministic, needsSmartMerge } from "../src/services/bufferBrain.service.js";
import { normalizeReplyText } from "../src/services/inboundGuard.service.js";
import { shouldThink } from "../src/services/agentThinking.service.js";

function ctx(text: string, mediaContext: any = null) {
  return { text, mediaContext } as any;
}

test("deterministic merge never loses a fact", () => {
  assert.equal(
    mergePartsDeterministic(["маған пицца", "бар ма", "алыңыз"]),
    "маған пицца бар ма алыңыз"
  );
  assert.equal(mergePartsDeterministic(["  hello  ", "", "world"]), "hello world");
  assert.equal(mergePartsDeterministic([]), "");
});

test("smart merge only fires when gluing would actually lose meaning", () => {
  assert.equal(needsSmartMerge(["сәлем"]), false);
  assert.equal(needsSmartMerge(["ок", "жарайды"]), false);
  assert.equal(needsSmartMerge(["пицца", "қанша"]), false);
  assert.equal(
    needsSmartMerge([
      "Кешіріңіз, кеше тапсырыс берген едім",
      "бірақ әлі келген жоқ",
      "неге сонша кешікті айтуға бола ма",
    ]),
    true
  );
});

test("outbound reply normalization makes duplicates comparable", () => {
  assert.equal(normalizeReplyText("  Сәлем!  Қалайсыз? \n"), "сәлем! қалайсыз?");
  assert.equal(normalizeReplyText("A  B\nC"), "a b c");
  assert.ok(normalizeReplyText("x".repeat(1000)).length <= 600);
});

test("confident tool plans skip the think call and stay fast", () => {
  assert.equal(shouldThink(ctx("Сколько стоит Маргарита?"), { requiredTools: ["searchMenu"] }), false);
  assert.equal(shouldThink(ctx("Мекенжайыңыз қандай?"), { requiredTools: ["getBusinessInfo"] }), false);
  assert.equal(shouldThink(ctx("Тапсырысым қайда?"), { requiredTools: ["checkOrderStatus"] }), false);
});

test("complaints and emotion still earn the pre-pass even with a plan", () => {
  assert.equal(shouldThink(ctx("заказ опаздывает уже час!!"), { requiredTools: ["checkOrderStatus"] }), true);
  assert.equal(shouldThink(ctx("оператор шақырыңызшы, тапсырысым кешікті"), { requiredTools: ["checkOrderStatus"] }), true);
});

test("media turns keep the pre-pass even with a confident plan", () => {
  assert.equal(shouldThink(ctx("мынау не?", { kind: "photo" }), { requiredTools: ["searchMenu"] }), true);
});

test("without a plan the old rules still apply", () => {
  assert.equal(shouldThink(ctx("Сәлем")), false);
  assert.equal(shouldThink(ctx("заказ келмеді, не істейін?")), true);
});

import test from "node:test";
import assert from "node:assert/strict";
import { phrasingMemoryBlock, readPhrasingMemory } from "../src/services/phrasingMemory.service.js";
import { resolvePaceUrgency } from "../src/services/responsePlan.service.js";

/**
 * "Сөйлем қорын кеңейту керек" (owner, 2026-08-29).
 *
 * The instructions have always asked for fresh wording, but asking is not an input: the
 * model could not see that it had opened the last four replies the same way, because
 * recent_dialog is a wall of text it skims for facts, not a list of its own habits.
 */
function ctxWith(history: any[]) {
  return { chatHistory: history, text: "", config: {} } as any;
}

const bot = (text: string) => ({ role: "assistant", text });
const guest = (text: string) => ({ role: "user", text });

test("the bot's own openings are collected, the guest's words are not", () => {
  const memory = readPhrasingMemory(ctxWith([
    guest("салам"),
    bot("Сәлеметсіз бе! Қалай көмектесе аламын?"),
    guest("донер бар ма"),
    bot("Иә, донер бар. 1590 теңге."),
  ]));

  assert.equal(memory.openings.length, 2);
  assert.ok(memory.openings.some((opening) => opening.startsWith("Сәлеметсіз бе")));
  assert.ok(memory.openings.some((opening) => opening.startsWith("Иә")));
  // The guest's "салам" is theirs, not a habit of ours.
  assert.ok(!memory.openings.some((opening) => opening.toLowerCase().includes("салам")));
});

test("an opening used twice is named explicitly as overused", () => {
  const memory = readPhrasingMemory(ctxWith([
    bot("Сәлеметсіз бе! Қалай көмектесе аламын?"),
    guest("донер"),
    bot("Сәлеметсіз бе! Донер 1590 теңге."),
  ]));

  assert.ok(memory.repeatedOpening);
  assert.match(String(memory.repeatedOpening), /Сәлеметсіз бе/);
});

test("a fresh opening is not flagged as overused", () => {
  const memory = readPhrasingMemory(ctxWith([
    bot("Сәлеметсіз бе! Қалай көмектесе аламын?"),
    guest("донер"),
    bot("Донер бар, 1590 теңге."),
  ]));

  assert.equal(memory.repeatedOpening, null);
});

test("a closing invitation is remembered, a price line is not mistaken for one", () => {
  const memory = readPhrasingMemory(ctxWith([
    bot("Донер 1590 теңге. Қосымша сұрағыңыз болса, жазыңыз."),
  ]));

  assert.equal(memory.closings.length, 1);
  assert.match(memory.closings[0], /сұрағыңыз болса/);
  // The factual sentence must never be treated as a sign-off to avoid.
  assert.ok(!memory.closings.some((closing) => closing.includes("1590")));
});

// The operator is a different human writing in their own voice; their phrasing is not
// the bot's habit and must not be suppressed as one.
test("operator messages are excluded", () => {
  const memory = readPhrasingMemory(ctxWith([
    { role: "operator", text: "Сәлеметсіз бе, мен оператормын." },
    { role: "assistant", source: "operator_panel", text: "Сәлеметсіз бе, тексеріп жатырмын." },
  ]));

  assert.deepEqual(memory.openings, []);
  assert.equal(phrasingMemoryBlock(ctxWith([{ role: "operator", text: "Сәлеметсіз бе." }])), null);
});

test("a first conversation carries no extra prompt weight", () => {
  assert.equal(phrasingMemoryBlock(ctxWith([])), null);
  assert.equal(phrasingMemoryBlock(ctxWith([guest("салам")])), null);
});

test("the block tells the model to vary wording without touching facts", () => {
  const block = phrasingMemoryBlock(ctxWith([
    bot("Сәлеметсіз бе! Донер 1590 теңге. Қосымша сұрағыңыз болса, жазыңыз."),
    guest("рахмет"),
    bot("Сәлеметсіз бе! Рахмет сізге."),
  ]));

  assert.ok(block);
  assert.ok(Array.isArray(block!.openings_you_already_used));
  assert.match(block!.rule, /Open this reply differently/);
  // The hard boundary: freshness never costs a fact.
  assert.match(block!.rule, /Never drop or soften a verified fact/);
  assert.match(block!.rule, /never mention this list/);
});

// The typing rhythm exists to feel human, but for an angry guest speed IS the courtesy.
test("pace urgency follows the mood the think layer read", () => {
  assert.equal(resolvePaceUrgency({ thinking: { mood: "angry" } } as any), "urgent");
  assert.equal(resolvePaceUrgency({ thinking: { mood: "rushed" } } as any), "urgent");
  assert.equal(resolvePaceUrgency({ thinking: { urgency: "high" } } as any), "urgent");
  assert.equal(resolvePaceUrgency({ thinking: { risk: "high" } } as any), "urgent");
  assert.equal(resolvePaceUrgency({ thinking: { mood: "confused" } } as any), "calm");
  assert.equal(resolvePaceUrgency({ thinking: { mood: "neutral" } } as any), "normal");
  // No analysis at all must behave exactly like an ordinary turn.
  assert.equal(resolvePaceUrgency({} as any), "normal");
});

import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";
import { validateFinalText } from "../src/agent/finalValidator.js";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";

const NOTE = "пицца пеперони жоқ, свет өшіп қалды";

function ctx(overrides: Record<string, any> = {}) {
  return {
    instanceId: "prestige", language: "kk", text: "", config: { brand: "Test" },
    chatHistory: [], shporContext: [],
    activeShiftNotes: [{ noteId: "27", text: NOTE, expiresAt: Date.now() + 3600_000 }],
    customerProfile: null, thinking: null, activeGoal: null, proactiveSignals: null,
    hardRealtimeContext: {}, runtimeStatus: null, ...overrides,
  } as any;
}

test("raw operator note text never enters the model context", () => {
  const out = buildFactsPrompt(ctx({ text: "пицца барма?" }));
  assert.ok(!out.includes(NOTE), "verbatim note text must not appear");
  assert.ok(!out.includes("свет өшіп"), "no internal operator wording");
  assert.ok(out.includes("unavailable_now"), "derived constraint must be present");
  assert.ok(out.includes("CONFIDENTIAL SOURCE"));
});

test("a leaked provenance sentence is cut, the useful answer survives", () => {
  const leak = 'Өкінішке орай, пицца жоқ. Оператордың ескертпесі бойынша "пицца пеперони жоқ". Басқа тағам ұсынайын ба?';
  const res = validateFinalText(leak, ctx() as any);
  assert.ok(res.warnings.includes("internal_disclosure_removed"));
  assert.ok(!/оператор/i.test(res.text), "provenance must be gone");
  assert.ok(res.text.includes("пицца жоқ"), "useful part survives");
  assert.ok(res.text.includes("ұсынайын"), "alternative offer survives");
});

test("russian provenance wording is redacted too", () => {
  const res = validateFinalText("Сейчас пиццы нет. В заметке системы указано, что нет пепперони.", ctx({ language: "ru" }) as any);
  assert.ok(res.warnings.includes("internal_disclosure_removed"));
  assert.ok(!/заметк/i.test(res.text));
});

test("a clean reply is untouched", () => {
  const clean = "Қазір пицца уақытша жоқ. Орнына донер немесе ролл ұсына аламын.";
  const res = validateFinalText(clean, ctx() as any);
  assert.equal(res.text, clean);
  assert.ok(!res.warnings.includes("internal_disclosure_removed"));
});

test("instructions forbid revealing internal machinery", () => {
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("Internal machinery is invisible to the customer"));
  assert.ok(FASTFOOD_AGENT_INSTRUCTIONS.includes("never say where a fact came from"));
});

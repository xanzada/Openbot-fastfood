import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";
import { planResponse, readCustomerStyle } from "../src/services/responsePlan.service.js";

function ctx(overrides: Record<string, any> = {}) {
  return {
    instanceId: "prestige",
    language: "kk",
    text: "",
    config: { brand: "Test" },
    chatHistory: [],
    shporContext: [],
    activeShiftNotes: [],
    customerProfile: null,
    thinking: null,
    activeGoal: null,
    proactiveSignals: null,
    hardRealtimeContext: {},
    runtimeStatus: null,
    ...overrides,
  } as any;
}

function userTurns(...texts: string[]) {
  return texts.map((text) => ({ role: "user", text }));
}

// Tone adaptation used to live only inside a prompt paragraph, so the model never
// saw HOW this guest writes and answered everyone in the same register and length
// (owner request, 2026-08-24). The shape is now computed in code.

test("a guest who writes two words gets a tight plan", () => {
  const plan = planResponse(ctx({ text: "барма", chatHistory: userTurns("салам", "донер") }));
  assert.equal(plan.length, "tight");
  assert.equal(plan.maxSentences, 2);
  assert.equal(plan.segments, "single");
});

test("a long, detailed message earns room and message splitting", () => {
  const long = "Сәлеметсіз бе, менде сұрақ бар: балама аллергия бар, теңіз өнімдері жарамайды, сондықтан не ұсынасыздар және бағасы қанша болады екен?";
  const plan = planResponse(ctx({ text: long, chatHistory: userTurns(long) }));
  assert.equal(plan.length, "roomy");
  assert.equal(plan.segments, "split");
  assert.ok(plan.maxSentences >= 4);
});

test("emoji is mirrored only when the guest uses it", () => {
  const withEmoji = planResponse(ctx({ text: "рақмет 🙂", chatHistory: userTurns("сәлем 👍") }));
  assert.equal(withEmoji.emoji, "mirror");
  const without = planResponse(ctx({ text: "рақмет", chatHistory: userTurns("сәлем") }));
  assert.equal(without.emoji, "sparing");
});

test("an upset or high-risk turn forbids emoji entirely", () => {
  const plan = planResponse(ctx({
    text: "ақшамды қайтарыңдар!!",
    chatHistory: userTurns("тапсырысым келмеді"),
    thinking: { mood: "upset", risk: "high", urgency: "high", complexity: "moderate" },
  }));
  assert.equal(plan.emoji, "none");
  assert.equal(plan.length, "tight", "an angry guest gets the answer, not a paragraph");
});

test("a confused guest is given room even when writing briefly", () => {
  const plan = planResponse(ctx({
    text: "түсінмедім",
    chatHistory: userTurns("а"),
    thinking: { mood: "confused", risk: "low", urgency: "normal", complexity: "moderate" },
  }));
  assert.equal(plan.length, "roomy");
  assert.equal(plan.segments, "split");
});

test("register follows how the guest addresses us", () => {
  assert.equal(readCustomerStyle(ctx({ text: "Сәлеметсіз бе, айтыңызшы өтінемін" })).register, "formal");
  assert.equal(readCustomerStyle(ctx({ text: "прив, скинь меню давай" })).register, "casual");
  assert.equal(readCustomerStyle(ctx({ text: "донер қанша" })).register, "neutral");
});

test("reply_shape reaches FACTS with a wording-only guarantee", () => {
  const out = buildFactsPrompt(ctx({ text: "барма", chatHistory: userTurns("салам") }));
  assert.ok(out.includes('"reply_shape"'), "the plan must reach the agent");
  assert.ok(out.includes('"max_sentences"'));
  assert.ok(out.includes("shapes WORDING only"), "it must never be allowed to drop a business rule");
  assert.ok(out.includes("never drop a required warning, a wait question, or a verified fact"));
});

test("a first-ever message with no history still produces a shape", () => {
  const out = buildFactsPrompt(ctx({ text: "сәлем, донер бар ма?" }));
  assert.ok(out.includes('"reply_shape"'));
});

test("an empty turn falls back to the neutral shape", () => {
  // No sample means nothing to adapt to, so the plan stays neutral rather than
  // disappearing: a shape is always cheaper than the model guessing.
  const out = buildFactsPrompt(ctx({ text: "" }));
  assert.ok(out.includes('"reply_shape"'));
  assert.ok(out.includes('"register": "neutral"'));
});

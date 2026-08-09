import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";

const MENU = {
  source: "dle_spa_items",
  count: 3,
  items: [
    { name: "Футомаки", price: 2300, category: "Суши", composition: "Күріш, балық, нори." },
    { name: "Хосомаки", price: 2250, category: "Суши", composition: "Күріш, қияр, нори." },
    { name: "Донер", price: 1000, category: "Донер", composition: "Лаваш, тауық еті, көкөніс." },
  ],
};

function contextWith(menuSnapshot: any): any {
  return {
    instanceId: "prestige",
    phone: "77476884956",
    text: "почем футомаки",
    senderMeta: {},
    language: "ru",
    languagePolicy: {},
      config: { brand: "Crazy Sushi", domain: "https://prestige.alemi.kz" },
    runtimeStatus: null,
    fetchedSettings: {},
    hardRealtimeContext: {},
    activeOrder: null,
    chatHistory: [],
    menuSnapshot,
    activeShiftNotes: [],
    activeShiftNotesFingerprint: "",
    mediaContext: null,
    shporContext: [],
    magicLinkAlreadySent: false,
    customerProfile: null,
    conversationSummary: null,
    lastTurnTrace: null,
    activeGoal: null,
    thinking: null,
    proactiveSignals: null,
    explicitMenuLinkIntent: false,
    magicLink: "",
  };
}

// The bug this guards: the menu only reached the agent when the model chose to
// call searchMenu. On the turns it did not, the context held no menu at all and
// the model announced real dishes as "temporarily unavailable".
test("the live menu travels with every turn, so the agent never guesses what exists", () => {
  const prompt = buildFactsPrompt(contextWith(MENU));
  assert.ok(prompt.includes("menu_snapshot"));
  assert.ok(prompt.includes("Футомаки"));
  assert.ok(prompt.includes("2300"));
  // Composition has to travel too: it is what makes a replacement honest.
  assert.ok(prompt.includes("Лаваш, тауық еті"));
});

test("a dish may be called unavailable only from the menu or an operator note", () => {
  const prompt = buildFactsPrompt(contextWith(MENU));
  assert.ok(prompt.includes("ONLY when it is absent from this list or blocked by an operator constraint"));
  assert.ok(prompt.includes("offer a real replacement by name and price"));
});

test("when the menu cannot be preloaded the agent is told to look it up, not to improvise", () => {
  const prompt = buildFactsPrompt(contextWith(null));
  assert.ok(prompt.includes("menu_snapshot_unavailable"));
  assert.ok(prompt.includes("Call searchMenu before saying anything about what exists"));
  assert.ok(!prompt.includes("\"menu_snapshot\":"));
});

import test from "node:test";
import assert from "node:assert/strict";
import { resolveAgentToolPlan, createAgentStepPolicy } from "../src/agent/toolPolicy.js";
import { hasDirectOrderIntent } from "../src/utils/orderIntent.js";

const phrases = ["Кола бар ма?", "Кола алайын", "Маған кока-кола керек", "Мне колу", "Тогда колу", "А напитки?", "Ішетін не бар?", "Спрайт есть?", "Два донера и колу", "Кола жоқ болса, не бар?"];
const direct = new Set(["Кола алайын", "Маған кока-кола керек", "Мне колу", "Тогда колу", "Два донера и колу"]);
const ctx = (text: string, extra: Record<string, any> = {}) => ({
  text, instanceId: "fixture-menu", phone: "77000000000", language: "kk",
  runtimeStatus: { is_accepting_orders: true, within_work_hours: true },
  activeShiftNotes: [], activeOrder: null, explicitMenuLinkIntent: false, ...extra,
} as any);
for (const phrase of phrases) for (const kind of ["text", "audio"]) {
  test(`${kind} live lookup before factual answer or order link: ${phrase}`, () => {
    const plan = resolveAgentToolPlan(ctx(phrase, { mediaContext: kind === "audio" ? { kind, transcript: phrase } : null }));
    assert.equal(plan.requiredTools[0], "searchMenu");
    assert.deepEqual(createAgentStepPolicy(plan)({ stepNumber: 0 }), { toolChoice: { type: "tool", toolName: "searchMenu" } });
    // Product authorization is recomputed after the mandatory fresh lookup.
    assert.equal(plan.requiredTools.includes("sendMenuLink"), false);
    assert.equal(hasDirectOrderIntent(phrase), direct.has(phrase));
  });
}
test("catalog name detects a product beyond the canned dish vocabulary", () => {
  const plan = resolveAgentToolPlan(ctx("Раф алайын", { menuSnapshot: { items: [{ name: "Раф", price: 1400 }] } }));
  assert.equal(plan.requiredTools[0], "searchMenu");
});
test("generic checkout and explicit link still start with link; greetings do not read menu", () => {
  for (const text of ["Хочу заказать", "Сілтеме жіберіңіз", "меню скинь"]) assert.equal(resolveAgentToolPlan(ctx(text)).requiredTools[0], "sendMenuLink", text);
  assert.deepEqual(resolveAgentToolPlan(ctx("Сәлеметсіз бе")).requiredTools, []);
});
test("a named direct order checks the catalog even while checkout is blocked", () => {
  for (const runtimeStatus of [{ is_accepting_orders: false, within_work_hours: true }, { is_accepting_orders: false, within_work_hours: true, emergency_stop: true }]) {
    const plan = resolveAgentToolPlan(ctx("Кола алайын", { runtimeStatus }));
    assert.equal(plan.requiredTools[0], "searchMenu");
    assert.equal(plan.requiredTools.includes("sendMenuLink"), false);
  }
});


const { groundMenuTurn, menuQueryForTurn, selectPublicMenuItems } = await import("../src/skills/searchMenu.skill.js");
const { answerAgentFailure, answerVoiceMenuOverview } = await import("../src/services/turnSafetyNet.service.js");
const liveItems = [
  { name: "Coca-Cola", category_name: "Напитки", price: 450, available: true },
  { name: "Спрайт", category_name: "Напитки", price: 500, available: true },
  { name: "Тауық донер", category_name: "Донер", price: 1600, available: true },
  { name: "Фанта", category_name: "Напитки", price: 490, available: false },
];
test("mandatory lookup uses fresh reader once, replacing stale facts even when model calls no tools", async () => {
  const c = ctx("Мне колу", { menuSnapshot: { items: [{ name: "Coca-Cola", price: 1 }] } });
  const reads: any[] = [];
  const reader = async (...args: any[]) => { reads.push(args); return { items: liveItems, source: "live-fixture" }; };
  const result = await groundMenuTurn(c, reader as any);
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0][3], { forceFresh: true });
  assert.equal(result.items[0].name, "Coca-Cola");
  assert.equal(result.items[0].price, 450);
  assert.equal(result.items[0].match_kind, "exact_name");
  assert.equal((await groundMenuTurn(c, reader as any)), result);
  assert.equal(reads.length, 1);
});
test("sold-out and active note facts override catalog; note deletion applies on next turn", async () => {
  const reader = async () => ({ items: liveItems, source: "live-fixture" });
  const blocked = ctx("Кола алайын", { activeShiftNotes: [{ id: "n-cola", text: "Coca-Cola нет" }] });
  const result = await groundMenuTurn(blocked, reader as any);
  assert.equal(result.items.length, 0);
  assert.ok(result.safe_alternatives.length > 0);
  assert.ok(result.safe_alternatives.every((i: any) => i.name !== "Coca-Cola" && i.name !== "Фанта"));
  const next = await groundMenuTurn(ctx("Кола алайын", { activeShiftNotes: [] }), reader as any);
  assert.equal(next.items[0].name, "Coca-Cola");
});
test("unreachable live menu clears stale snapshot and reports uncertainty", async () => {
  const c = ctx("Кола бар ма?", { menuSnapshot: { items: liveItems } });
  const result = await groundMenuTurn(c, (async () => ({ items: [], source: "menu_unavailable" })) as any);
  assert.equal(result.menu_lookup, "unavailable");
  assert.deepEqual(c.menuSnapshot.items, []);
  let links = 0, cases = 0;
  const reply = await answerAgentFailure(c, Error("ALL_MODELS_FAILED"), (async () => { cases++; }) as any, async () => { links++; return true; });
  assert.match(reply, /тексере алмай/);
  assert.equal(cases, 0); assert.equal(links, 0); assert.doesNotMatch(reply, /450|қабылдан|тапсырыс.*берілді/);
});
for (const phrase of phrases) {
  test("provider failure still answers grounded text/transcript without false SOS: " + phrase, async () => {
    for (const kind of ["text", "audio"]) {
      const c = ctx(phrase, { language: /[әғқңөұүһі]/u.test(phrase) ? "kk" : "ru", mediaContext: kind === "audio" ? { kind } : null });
      let links = 0, cases = 0;
      const reply = await answerAgentFailure(c, Error("TOOL_CHOICE_IGNORED"), (async () => { cases++; return { action: "operator_case_created" }; }) as any,
        async () => { links++; c.magicLinkGranted = true; return true; }, (async () => ({ items: liveItems })) as any);
      assert.equal(cases, 0);
      assert.ok(reply.length > 0);
      // RU and KK forms of the same broad category browse have identical link behavior.
      assert.equal(links, direct.has(phrase) || phrase === "А напитки?" || phrase === "Ішетін не бар?" ? 1 : 0, phrase);
      assert.doesNotMatch(reply, /заказ.*принят|тапсырыс.*қабылдан|TOOL_CHOICE|Gemini|OpenRouter/iu);
      assert.ok(!reply.includes("Фанта"));
    }
  });
}
test("missing named drink offers only factual available alternatives", async () => {
  const c = ctx("Мне колу", { activeShiftNotes: [{ id: "n-cola", text: "Coca-Cola нет" }] });
  let links = 0;
  const reply = await answerAgentFailure(c, Error("timeout"), (async () => { throw Error("false SOS"); }) as any,
    async () => { links++; return true; }, (async () => ({ items: liveItems })) as any);
  assert.match(reply, /Спрайт — 500/); assert.doesNotMatch(reply, /Coca-Cola —|Фанта —/);
  assert.equal(links, 0);
});
test("a voice drink overview reads live facts and never sends a needless link", async () => {
  const c = ctx("Ішетін не бар?", { mediaContext: { kind: "audio" }, menuSnapshot: { items: [{ name: "Old drink", price: 1 }] } });
  let links = 0;
  const reply = await answerVoiceMenuOverview(c, async () => { links++; return true; }, (async () => ({ items: liveItems })) as any);
  assert.match(String(reply), /Coca-Cola — 450/); assert.match(String(reply), /Спрайт — 500/);
  assert.doesNotMatch(String(reply), /Old drink|Фанта/); assert.equal(links, 0);
});
test("query normalization distinguishes exact product from similar named options", () => {
  assert.equal(menuQueryForTurn("Маған кока-кола керек"), "кола");
  const exact = selectPublicMenuItems(liveItems, menuQueryForTurn("Мне колу"));
  assert.equal(exact[0].match_kind, "exact_name");
  const similar = selectPublicMenuItems([{ name: "Ванильный раф", price: 1500 }], "раф");
  assert.equal(similar[0].match_kind, "similar");
});



test("menu-location questions cannot escalate a provider failure; ordinary status reads fresh and a real operator request still escalates", async () => {
 let cases = 0;
 const route = async () => { cases++; return { action: "operator_case_created" }; };
 const reader = async () => ({ items: liveItems });
 for (const text of ["Мәзірді қайдан қараймын?", "Где посмотреть меню?"]) {
  await answerAgentFailure(ctx(text), Error("timeout"), route as any, async () => false, reader as any);
  assert.equal(cases, 0, text);
 }
 for (const text of ["Тапсырысым қайда?", "Где мой заказ?"]) {
  await answerAgentFailure(ctx(text), Error("timeout"), route as any, async () => false, reader as any, (async () => ({ state: "unavailable" })) as any);
 }
 assert.equal(cases, 0);
 for (const text of ["Хочу живого оператора", "Оператормен сөйлескім келеді"]) await answerAgentFailure(ctx(text), Error("timeout"), route as any, async () => false, reader as any);
 assert.equal(cases, 2);
});

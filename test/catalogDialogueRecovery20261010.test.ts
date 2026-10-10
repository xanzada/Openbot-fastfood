import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { validateFinalText } from "../src/agent/finalValidator.js";
import { groundMenuTurn, menuQueryForTurn, pageMenuMatches, selectPublicMenuItems } from "../src/skills/searchMenu.skill.js";

const now = Date.now();
const menu = [
  { name: "Маргарита Романа", category_name: "Римская пицца", composition: "Тесто, томаты", price: 2200, available: true },
  { name: "Пепперони Классика", category_name: "Классические пиццы", composition: "Тесто, колбаса", price: 2800, available: true },
  { name: "Детская сырная", category_name: "Мини-пиццы", composition: "Тесто, сыр", price: 1700, available: true },
  { name: "Зелёная с травами", category_name: "Лепёшки", composition: "Тесто, базилик", price: 1300, available: true },
  { name: "Шоколадный квадрат", category_name: "Десерты", composition: "Какао", price: 1100, available: true },
  { name: "Лимонная вода", category_name: "Напитки", composition: "Лимон, вода", price: 650, available: true },
];

const ctx = (text: string, extra: any = {}) => ({
  instanceId: "catalog-dialogue-fixture",
  phone: "77000000001",
  text,
  senderMeta: {},
  language: "ru",
  languagePolicy: {},
  config: { domain: "https://fixture.invalid" },
  runtimeStatus: { runtime_available: true, is_accepting_orders: true, within_work_hours: true, is_emergency: false, wait_time: 0 },
  hardRealtimeContext: { runtime_available: true, is_accepting_orders: true, within_work_hours: true, is_emergency: false, wait_time: 0 },
  fetchedSettings: {},
  activeOrder: null,
  chatHistory: [],
  menuSnapshot: { items: menu, source: "fixture" },
  menuGrounding: { menu_lookup: "fixture" },
  activeShiftNotes: [],
  activeShiftNotesFingerprint: "",
  mediaContext: null,
  shporContext: [],
  magicLinkAlreadySent: false,
  magicLinkGranted: false,
  explicitMenuLinkIntent: false,
  magicLink: null,
  ...extra,
} as any);

test("catalog morphology finds every live category branch and generic ingredient without dish dictionaries", () => {
  for (const query of ["пицца", "пиццу", "пиццы", "пиццалар"]) {
    const names = selectPublicMenuItems(menu, query, "", menu.length).map((item: any) => item.name);
    assert.deepEqual(names.slice().sort(), ["Детская сырная", "Маргарита Романа", "Пепперони Классика"].sort(), query);
    assert.ok(!names.includes("Шоколадный квадрат"), query);
  }
  assert.deepEqual(selectPublicMenuItems(menu, "лепёшку", "", menu.length).map((item: any) => item.name), ["Зелёная с травами"]);
  assert.deepEqual(selectPublicMenuItems(menu, "базиликом", "", menu.length).map((item: any) => item.name), ["Зелёная с травами"]);
});

test("catalog-derived category matching counts and pages more than sixty results", () => {
  const large = Array.from({ length: 73 }, (_, index) => ({
    name: `Fixture ${index + 1}`,
    category_name: index % 3 === 0 ? "Римская пицца" : index % 3 === 1 ? "Классические пиццы" : "Мини-пиццы",
    price: 1000 + index,
  }));
  const matches = selectPublicMenuItems(large, "пиццу", "", large.length);
  const page = pageMenuMatches(matches);
  assert.equal(matches.length, 73);
  assert.equal(page.returned, 50);
  assert.equal(page.totalMatched, 73);
  assert.equal(page.nextOffset, 50);
});

for (const followUp of ["есть другие?", "а ещё?", "тағы да?"]) {
  test(`alternative follow-up recovers only the fresh scoped customer category: ${followUp}`, () => {
    const c = ctx(followUp, {
      chatHistory: [{
        role: "user",
        text: "Хочу посмотреть пиццу",
        instanceId: "catalog-dialogue-fixture",
        phone: "77000000001",
        createdAt: now - 1000,
      }],
    });
    assert.equal(menuQueryForTurn(followUp, c), "пиццу");
    assert.deepEqual(resolveAgentToolPlan(c).requiredTools.slice(0, 2), ["searchMenu", "sendMenuLink"]);
  });
}

test("assistant prose, another tenant, and stale customer turns never supply the alternative topic", () => {
  const assistantOnly = ctx("есть другие?", { chatHistory: [{ role: "assistant", text: "У нас есть пиццы.", createdAt: now - 1000 }] });
  assert.equal(menuQueryForTurn(assistantOnly.text, assistantOnly), "");
  const foreign = ctx("есть другие?", { chatHistory: [{ role: "user", text: "Пиццу", instanceId: "other", phone: "77000000001", createdAt: now - 1000 }] });
  assert.equal(menuQueryForTurn(foreign.text, foreign), "");
  const stale = ctx("есть другие?", { chatHistory: [{ role: "user", text: "Пиццу", instanceId: "catalog-dialogue-fixture", phone: "77000000001", createdAt: now - 31 * 60_000 }] });
  assert.equal(menuQueryForTurn(stale.text, stale), "");
});

test("explicit category switch wins, while conversational and unrelated follow-up noise is filtered", () => {
  const history = [{ role: "user", text: "Хочу пиццу", instanceId: "catalog-dialogue-fixture", phone: "77000000001", createdAt: now - 1000 }];
  assert.equal(menuQueryForTurn("А напитки?", ctx("А напитки?", { chatHistory: history })), "напитки");
  assert.equal(menuQueryForTurn("спасибо", ctx("спасибо", { chatHistory: history })), "");
  assert.equal(menuQueryForTurn("есть другие способы оплаты?", ctx("есть другие способы оплаты?", { chatHistory: history })), "способы оплаты");
});

test("category consultation plans grounded search then self-ordering link and retains kitchen/payment gates", () => {
  assert.deepEqual(resolveAgentToolPlan(ctx("Какие пиццы у вас есть?")).requiredTools.slice(0, 2), ["searchMenu", "sendMenuLink"]);
  const closed = { runtime_available: true, is_accepting_orders: false, within_work_hours: true, is_emergency: true, wait_time: 0 };
  const closedPlan = resolveAgentToolPlan(ctx("Какие пиццы у вас есть?", { runtimeStatus: closed, hardRealtimeContext: closed }));
  assert.ok(closedPlan.requiredTools.includes("searchMenu"));
  assert.ok(!closedPlan.requiredTools.includes("sendMenuLink"));
  const payment = resolveAgentToolPlan(ctx("Есть другие способы оплаты?"));
  assert.ok(!payment.requiredTools.includes("searchMenu"));
  assert.ok(!payment.requiredTools.includes("sendMenuLink"));
});

test("morphology lookup still applies note and sold-out barriers before alternatives", async () => {
  const c = ctx("пиццу", {
    menuGrounding: undefined,
    activeShiftNotes: [{ id: "fixture-note", text: "Маргарита Романа нет" }],
  });
  const live = [...menu, { name: "Северная большая", category_name: "Пиццы", price: 2500, available: false }];
  const result: any = await groundMenuTurn(c, (async () => ({ items: live, source: "fixture-live" })) as any);
  const names = result.items.map((item: any) => item.name);
  assert.ok(!names.includes("Маргарита Романа"));
  assert.ok(!names.includes("Северная большая"));
  assert.ok(result.unavailable_now.some((name: string) => /маргарита/iu.test(name)));
  assert.ok(result.unavailable_now.some((name: string) => /северная/iu.test(name)));
});

test("order-taking selection questions are removed in both languages", () => {
  for (const [language, raw] of [
    ["kk", "Пиццалардың қайсысын аласыз?"],
    ["kk", "Қай пиццаға тапсырыс бересіз?"],
    ["kk", "Қай пиццаны аласыз?"],
    ["kk", "Қай түрін таңдайсыз?"],
    ["ru", "Какую из них будете заказывать?"],
  ]) {
    const result = validateFinalText(raw, ctx("Какие пиццы у вас есть?", { language }), { toolsCalled: ["searchMenu", "sendMenuLink"] });
    assert.doesNotMatch(result.text, /қайсысын аласыз|пиццаны аласыз|тапсырыс бересіз|түрін таңдайсыз|будете заказывать/iu);
    assert.ok(result.warnings.includes("menu_selection_question_removed"));
  }
});

test("necessary operational and safety clarifications remain available", () => {
  for (const raw of ["Қай мекенжайға жеткізу керек?", "Қай мекенжайға тапсырыс бересіз?", "Аллергияңыз бар ма?", "Қай мөлшерді тексерейін?"]) {
    assert.equal(validateFinalText(raw, ctx("Маған ақпарат керек", { language: "kk" }), { toolsCalled: [] }).text, raw);
  }
});

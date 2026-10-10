import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "100";
process.env.REDIS_OPERATION_TIMEOUT_MS = "100";

const toolPolicy = await import("../src/agent/toolPolicy.js");
const menuContext = await import("../src/utils/menuQuestionContext.js");
const { validateFinalText } = await import("../src/agent/finalValidator.js");
const { createSendMenuLinkSkill } = await import("../src/skills/menuLink.skill.js");
const { groundMenuTurn, menuQueryForTurn } = await import("../src/skills/searchMenu.skill.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => { if (redisClient.isOpen) redisClient.destroy(); });

const now = Date.now();
const open = { runtime_available: true, is_accepting_orders: true, within_work_hours: true, is_emergency: false, wait_time: 0 };
const menu = [
  { name: "Римская Альфа", category_name: "Римские пиццы", price: 2100, available: true },
  { name: "Римская Бета", category_name: "Римские пиццы", price: 2400, available: true },
  { name: "Римская Гамма", category_name: "Римские пиццы", price: 2700, available: true },
  { name: "Лимонный морс", category_name: "Напитки", price: 700, available: true },
];
const context = (text: string, extra: any = {}) => ({
  instanceId: "catalog-blocker-fixture",
  phone: "77000000001",
  text,
  senderMeta: {},
  language: "ru",
  languagePolicy: {},
  config: { domain: "https://fixture.invalid" },
  runtimeStatus: open,
  hardRealtimeContext: open,
  fetchedSettings: {},
  activeOrder: null,
  chatHistory: [],
  menuSnapshot: { items: menu, source: "fixture" },
  menuGrounding: undefined,
  activeShiftNotes: [],
  activeShiftNotesFingerprint: "",
  mediaContext: null,
  shporContext: [],
  magicLinkAlreadySent: false,
  magicLinkGranted: false,
  explicitMenuLinkIntent: false,
  magicLink: "https://fixture.invalid/order",
  ...extra,
} as any);

for (const text of [
  "Какие пиццы есть? Ссылку не присылай.",
  "Пиццы не нужны. Ссылку не присылай.",
  "Пицца керек емес, сілтемені жібермеңіз.",
]) {
  test(`current refusal blocks planner and real menu-link skill: ${text}`, async () => {
    const ctx = context(text);
    assert.ok(!toolPolicy.resolveAgentToolPlan(ctx).requiredTools.includes("sendMenuLink"));
    const result: any = await createSendMenuLinkSkill(ctx).execute({ reason: "category browse" });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "link_not_requested");
  });
}

test("the latest explicit RU/KK menu-link decision wins", async () => {
  for (const [text, allowed] of [
    ["Ссылку не присылай, хотя нет — пришли ссылку.", true],
    ["Пришли ссылку, нет — не присылай.", false],
    ["Сілтемені жібермеңіз, жоқ — жіберіңіз.", true],
    ["Сілтемені жіберіңіз, жоқ — жібермеңіз.", false],
  ] as const) {
    const ctx = context(text);
    assert.equal(toolPolicy.resolveAgentToolPlan(ctx).requiredTools.includes("sendMenuLink"), allowed, text);
    const result: any = await createSendMenuLinkSkill(ctx).execute({ reason: "latest decision" });
    assert.equal(result.allowed, allowed, text);
  }
});

test("exact informational product questions do not inherit broad-category link permission", async () => {
  for (const text of [
    "Что входит в Римскую Альфу?", "Сколько стоит Римская Альфа?",
    "Римская Альфаның құрамы қандай?", "Римская Альфаның бағасы қандай?",
  ]) {
    const ctx = context(text);
    assert.ok(toolPolicy.resolveAgentToolPlan(ctx).requiredTools.includes("searchMenu"));
    assert.ok(!toolPolicy.resolveAgentToolPlan(ctx).requiredTools.includes("sendMenuLink"));
    const result: any = await createSendMenuLinkSkill(ctx).execute({ reason: "exact informational question" });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "link_not_requested");
  }
});

test("bare тағы бар ма recovers only a fresh scoped customer category", () => {
  const history = [{ role: "user", text: "Пиццалар қандай?", instanceId: "catalog-blocker-fixture", phone: "77000000001", createdAt: now - 1000 }];
  const ctx = context("тағы бар ма?", { chatHistory: history });
  assert.equal(menuQueryForTurn(ctx.text, ctx), "пиццалар");
  assert.deepEqual(toolPolicy.resolveAgentToolPlan(ctx).requiredTools.slice(0, 2), ["searchMenu", "sendMenuLink"]);

  for (const badHistory of [
    [{ role: "assistant", text: "Пиццалар бар", createdAt: now - 1000 }],
    [{ role: "user", text: "Пиццалар қандай?", instanceId: "foreign", phone: "77000000001", createdAt: now - 1000 }],
    [{ role: "user", text: "Пиццалар қандай?", instanceId: "catalog-blocker-fixture", phone: "77000000999", createdAt: now - 1000 }],
    [{ role: "user", text: "Пиццалар қандай?", instanceId: "catalog-blocker-fixture", phone: "77000000001", createdAt: now - 31 * 60_000 }],
    [{ role: "user", text: "Мекенжай қайда?", instanceId: "catalog-blocker-fixture", phone: "77000000001", createdAt: now - 1000 }],
  ]) {
    const isolated = context("тағы бар ма?", { chatHistory: badHistory });
    assert.equal(menuQueryForTurn(isolated.text, isolated), "", JSON.stringify(badHistory));
    assert.ok(!toolPolicy.resolveAgentToolPlan(isolated).requiredTools.includes("sendMenuLink"));
  }
});

test("category grounding returns the full safe page and truthful total", async () => {
  const large = Array.from({ length: 73 }, (_, index) => ({ name: `Пицца ${index + 1}`, category_name: "Пиццалар", price: 1000 + index, available: true }));
  const ctx = context("Пиццалар қандай?", { menuSnapshot: { items: large.slice(0, 60), source: "preview" } });
  const result: any = await groundMenuTurn(ctx, (async () => ({ items: large, source: "live" })) as any);
  assert.equal(result.items.length, 50);
  assert.equal(result.totalMatched, 73);
  assert.equal(result.hasMore, true);
  assert.equal(result.nextOffset, 50);
});

test("grounding then output validation prevents a one-item broad-category answer", async () => {
  const ctx = context("Какие римские пиццы есть?");
  await groundMenuTurn(ctx, (async () => ({ items: menu, source: "live" })) as any);
  const result = validateFinalText("Римская Альфа — 2100 тг. Какая вам больше нравится?", ctx, { toolsCalled: ["searchMenu"] });
  for (const name of ["Римская Альфа", "Римская Бета", "Римская Гамма"]) assert.match(result.text, new RegExp(name, "u"));
  assert.doesNotMatch(result.text, /какая вам больше нравится/iu);
});

test("personalized recommendation may remain one verified item", async () => {
  const ctx = context("Посоветуйте одну римскую пиццу");
  await groundMenuTurn(ctx, (async () => ({ items: menu, source: "live" })) as any);
  const draft = "Римская Альфа — 2100 тг.";
  assert.equal(validateFinalText(draft, ctx, { toolsCalled: ["searchMenu"] }).text, draft);
});

test("contextual alternatives prefer live variants not already named by the assistant", async () => {
  const ctx = context("а ещё?", { chatHistory: [
    { role: "user", text: "Какие римские пиццы есть?", instanceId: "catalog-blocker-fixture", phone: "77000000001", createdAt: now - 2000 },
    { role: "assistant", text: "Римская Альфа — 2100 тг.", createdAt: now - 1500 },
  ] });
  const result: any = await groundMenuTurn(ctx, (async () => ({ items: menu, source: "live" })) as any);
  assert.equal(result.items[0].name, "Римская Бета");
  assert.ok(result.items.every((item: any) => menu.some((live) => live.name === item.name && live.price === item.price)));
});

test("a category beyond the preview is replanned after the live grounding refresh", async () => {
  const preview = Array.from({ length: 60 }, (_, index) => ({ name: `Пицца ${index}`, category_name: "Пиццы", price: 1000 + index, available: true }));
  const drinks = [{ name: "Морс Смородина", category_name: "Напитки", price: 700, available: true }, { name: "Морс Вишня", category_name: "Напитки", price: 750, available: true }];
  const ctx = context("А напитки?", { menuSnapshot: { items: preview, source: "preview" } });
  const initial = toolPolicy.resolveAgentToolPlan(ctx);
  assert.ok(!initial.requiredTools.includes("sendMenuLink"));
  await groundMenuTurn(ctx, (async () => ({ items: [...preview, ...drinks], source: "live" })) as any);
  const refresh = (toolPolicy as any).refreshAgentToolPlanAfterMenuGrounding;
  assert.equal(typeof refresh, "function");
  assert.ok(refresh(ctx, initial).requiredTools.includes("sendMenuLink"));
});

for (const text of [
  "Позовите оператора и пришлите ссылку на меню пиццы",
  "Пришлите меню пиццы, хочу пожаловаться: заказ испорчен",
]) {
  test(`mixed incident blocks the real link skill: ${text}`, async () => {
    const ctx = context(text);
    assert.ok(!toolPolicy.resolveAgentToolPlan(ctx).requiredTools.includes("sendMenuLink"));
    const result: any = await createSendMenuLinkSkill(ctx).execute({ reason: "explicit link" });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, "link_not_requested");
  });
}

test("lexeme relation keeps inflections without unrestricted prefix false positives", () => {
  assert.equal(menuContext.menuLexemesRelated("пицца", "пиццы"), true);
  assert.equal(menuContext.menuLexemesRelated("пицца", "пиццалар"), true);
  assert.equal(menuContext.menuLexemesRelated("базилик", "базиликом"), true);
  assert.equal(menuContext.menuLexemesRelated("салат", "салатник"), false);
});

test("quote stripping is bounded before scanning unmatched quote input", () => {
  const strip = (menuContext as any).stripMenuContextQuotes;
  assert.equal(typeof strip, "function");
  const result = strip("«".repeat(10_000) + "пиццы");
  assert.ok(result.length <= 4096);
  assert.equal(typeof menuQueryForTurn("«".repeat(10_000) + "пиццы", context("пиццы")), "string");
});

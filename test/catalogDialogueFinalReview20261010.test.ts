import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "100";
process.env.REDIS_OPERATION_TIMEOUT_MS = "100";

const { validateFinalText } = await import("../src/agent/finalValidator.js");
const { resolveAgentToolPlan } = await import("../src/agent/toolPolicy.js");
const { createSendMenuLinkSkill } = await import("../src/skills/menuLink.skill.js");
const { selectPublicMenuItems } = await import("../src/skills/searchMenu.skill.js");
const { menuLinkDecisionForTurn } = await import("../src/utils/magicLink.js");
const { getMenuBudgetInquiry, isMenuBudgetInquiry } = await import("../src/utils/menuBudget.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => { if (redisClient.isOpen) redisClient.destroy(); });

const open = { runtime_available: true, live: true, is_accepting_orders: true, within_work_hours: true, is_emergency: false, wait_time: 0 };
const pizzas = [
  { name: "Римская Альфа", category_name: "Пиццы", price: 2100, available: true },
  { name: "Римская Бета", category_name: "Пиццы", price: 2400, available: true },
  { name: "Римская Гамма", category_name: "Пиццы", price: 2900, available: true },
];
const ctx = (text: string, extra: any = {}) => ({
  instanceId: "final-review-fixture",
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
  menuSnapshot: { items: pizzas, source: "live" },
  menuGrounding: { category_browse: true, menu_lookup: "live", totalMatched: 3, items: pizzas },
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

test("category coverage never erases closed, emergency, wait or incident clauses", () => {
  const closed = { ...open, is_accepting_orders: false, is_emergency: true };
  const closedDraft = "Сейчас кухня закрыта. Римская Альфа — 2100 тг.";
  const closedResult = validateFinalText(closedDraft, ctx("Какие пиццы есть?", { runtimeStatus: closed, hardRealtimeContext: closed }), { toolsCalled: ["searchMenu", "getKitchenStatus"] });
  assert.match(closedResult.text, /кухня закрыта/iu);
  assert.doesNotMatch(closedResult.text, /Римская Бета|Римская Гамма/u);

  const waiting = { ...open, wait_time: 90 };
  const waitDraft = "Сейчас ожидание около 90 минут. Сможете подождать? Римская Альфа — 2100 тг.";
  const waitResult = validateFinalText(waitDraft, ctx("Какие пиццы есть?", { runtimeStatus: waiting, hardRealtimeContext: waiting }), { toolsCalled: ["searchMenu", "getKitchenStatus"] });
  assert.match(waitResult.text, /90 минут/iu);
  assert.match(waitResult.text, /подождать/iu);
  assert.doesNotMatch(waitResult.text, /Римская Бета|Римская Гамма/u);

  const incident = validateFinalText("Заказ испорчен, передаю вопрос оператору. Римская Альфа — 2100 тг.", ctx("Какие пиццы есть? Заказ испорчен, позовите оператора."), { toolsCalled: ["searchMenu", "escalateToAdmin"], toolFindings: { escalationCreated: true, escalationNotificationAccepted: true } });
  assert.match(incident.text, /оператор/iu);
  assert.doesNotMatch(incident.text, /Римская Бета|Римская Гамма/u);
});

test("category coverage preserves current unavailability while grounding allowed alternatives", () => {
  const result = validateFinalText(
    "Пепперони временно недоступна. Римская Альфа — 2100 тг.",
    ctx("Какие пиццы есть?", { menuGrounding: { category_browse: true, menu_lookup: "live", totalMatched: 3, items: pizzas, sold_out_now: ["Пепперони"] } }),
    { toolsCalled: ["searchMenu"] },
  );
  assert.match(result.text, /Пепперони временно недоступна/iu);
  for (const item of pizzas) assert.match(result.text, new RegExp(item.name, "u"));
});

test("numeric and qualitative category budgets cannot be overwritten by broad enumeration", () => {
  assert.equal(isMenuBudgetInquiry("Какие пиццы до 2500?"), true);
  assert.equal(getMenuBudgetInquiry("Какие пиццы до 2500?"), 2500);
  assert.equal(isMenuBudgetInquiry("Какие пиццы подешевле?"), true);
  assert.equal(isMenuBudgetInquiry("2500 теңгеге дейін қандай пиццалар бар?"), true);
  assert.equal(getMenuBudgetInquiry("2500 теңгеге дейін қандай пиццалар бар?"), 2500);
  assert.equal(isMenuBudgetInquiry("Арзанырақ пиццалар қандай?"), true);

  for (const [text, language] of [["Какие пиццы до 2500?", "ru"], ["2500 теңгеге дейін қандай пиццалар бар?", "kk"]] as const) {
    const result = validateFinalText("Римская Альфа — 2100 тг; Римская Бета — 2400 тг.", ctx(text, { language }), { toolsCalled: ["searchMenu"] });
    assert.match(result.text, /Римская Альфа/u);
    assert.match(result.text, /Римская Бета/u);
    assert.doesNotMatch(result.text, /Римская Гамма|2900/u);
    assert.ok(result.warnings.includes("budget_alternatives_grounded"));
  }

  const prior = { schema: "SHOPPING_SESSION_V1", tenant: "final-review-fixture", customerScope: "ignored-by-test", startedAt: Date.now(), revision: 1, budget: 2500, avoidMeat: false, uncertainBudget: false, expiresAt: Date.now() + 60_000 };
  const qualitative = validateFinalText("Римская Альфа — 2100 тг; Римская Бета — 2400 тг.", ctx("Какие пиццы подешевле?", { shoppingConstraints: prior }), { toolsCalled: ["searchMenu"] });
  assert.doesNotMatch(qualitative.text, /Римская Гамма|2900/u);
});

test("category coverage counts distinct boundary-aware names and renders duplicate source rows once", () => {
  const overlap = [
    { name: "Донер", category_name: "Донеры", price: 1800, available: true },
    { name: "Донер с курицей", category_name: "Донеры", price: 2100, available: true },
    { name: "Донер", category_name: "Донеры", price: 1800, available: true },
  ];
  const result = validateFinalText("Донер с курицей — 2100 тг.", ctx("Какие донеры есть?", {
    menuSnapshot: { items: overlap, source: "live" },
    menuGrounding: { category_browse: true, menu_lookup: "live", totalMatched: 3, items: overlap },
  }), { toolsCalled: ["searchMenu"] });
  assert.ok(result.warnings.includes("category_enumeration_grounded"));
  assert.equal((result.text.match(/Донер —/gu) || []).length, 1);
  assert.equal((result.text.match(/Донер с курицей —/gu) || []).length, 1);
});

test("payment-details priority is shared by planner and the real link skill", async () => {
  const c = ctx("Какие пиццы есть? Пришлите реквизиты оплаты.");
  assert.ok(resolveAgentToolPlan(c).requiredTools.includes("getPaymentDetails"));
  assert.ok(!resolveAgentToolPlan(c).requiredTools.includes("sendMenuLink"));
  const result: any = await createSendMenuLinkSkill(c).execute({ reason: "category browse" });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "link_not_requested");
});

test("bounded last explicit menu-link decision wins, including pronouns", async () => {
  const cases = [
    ["Не присылайте ссылку. Нет, пришлите её.", "allow"],
    ["Пришлите ссылку. Нет, не присылайте её.", "deny"],
    ["Сілтемені жібермеңіз. Жоқ, оны жіберіңіз.", "allow"],
    ["Сілтемені жіберіңіз. Жоқ, оны жібермеңіз.", "deny"],
    ["Какие пиццы есть? " + "а".repeat(4200) + ". Ссылку не присылай.", "deny"],
    ["Какие пиццы есть? Ссылку не присылай. " + "а".repeat(4200) + ". Нет, пришли её.", "allow"],
    ["Какие пиццы есть? Пришли ссылку. " + "а".repeat(4200) + ". Нет, не присылай её.", "deny"],
    ["Какие пиццы есть? " + "а".repeat(5000), "deny"],
  ] as const;
  for (const [text, decision] of cases) assert.equal(menuLinkDecisionForTurn(text), decision, text.slice(-100));

  const denied = ctx("Какие пиццы есть? " + "а".repeat(4200) + ". Ссылку не присылай.");
  assert.ok(!resolveAgentToolPlan(denied).requiredTools.includes("sendMenuLink"));
  assert.equal((await createSendMenuLinkSkill(denied).execute({ reason: "broad browse" }) as any).allowed, false);
  const allowed = ctx("Какие пиццы есть? " + "а".repeat(4200) + ". Пришли ссылку.");
  assert.ok(resolveAgentToolPlan(allowed).requiredTools.includes("sendMenuLink"));
  assert.equal((await createSendMenuLinkSkill(allowed).execute({ reason: "tail decision" }) as any).allowed, true);
});

test("menu scoring uses lexeme boundaries instead of raw prefix collisions", () => {
  const items = [
    { name: "Цезарь", category_name: "Салаты", composition: "курица, салат", price: 2300, available: true },
    { name: "Салатник 500 мл", category_name: "Посуда", price: 900, available: true },
    { name: "Чай зелёный", category_name: "Напитки", price: 500, available: true },
    { name: "Чайник стальной", category_name: "Посуда", price: 5000, available: true },
    { name: "Маргарита", category_name: "Пиццы", composition: "с базиликом", price: 2400, available: true },
  ];
  assert.deepEqual(selectPublicMenuItems(items, "салаты", "", 20).map((item: any) => item.name), ["Цезарь"]);
  assert.deepEqual(selectPublicMenuItems(items, "чай", "", 20).map((item: any) => item.name), ["Чай зелёный"]);
  assert.deepEqual(selectPublicMenuItems(items, "пицца", "", 20).map((item: any) => item.name), ["Маргарита"]);
  assert.deepEqual(selectPublicMenuItems(items, "базиликом", "", 20).map((item: any) => item.name), ["Маргарита"]);
});

test("operator notes and live sold-out state override stale menu prices at the final boundary", () => {
  const all = [
    { name: "Пицца Маргарита", category_name: "Пиццы", price: 2100, available: true },
    { name: "Пепперони", category_name: "Пиццы", price: 2300, available: false },
    { name: "Сырная", category_name: "Пиццы", price: 2400, available: true },
  ];
  const grounding = { category_browse: true, menu_lookup: "live", totalMatched: 1, items: [all[2]], sold_out_now: ["Пепперони"], unavailable_now: ["Пицца Маргарита"] };
  const base = { menuSnapshot: { items: all, source: "live" }, menuGrounding: grounding, activeShiftNotes: [{ text: "Пицца Маргарита жоқ", createdAt: Date.now() }] };
  for (const [language, raw, unavailable] of [
    ["ru", "Пицца Маргарита — 2100 тг.", /недоступ/iu],
    ["kk", "Пицца Маргарита — 2100 тг.", /қолжетімсіз|жоқ/iu],
    ["ru", "Пепперони — 2300 тг.", /недоступ/iu],
  ] as const) {
    const result = validateFinalText(raw, ctx("Какие пиццы есть?", { ...base, language }), { toolsCalled: ["searchMenu"] });
    assert.doesNotMatch(result.text, /2100|2300/u);
    assert.match(result.text, unavailable);
    assert.match(result.text, /Сырная/u);
    assert.doesNotMatch(result.text, /заметк|оператор указал/iu);
  }

  const historical = "Вчера Пицца Маргарита стоила 2100 тг.";
  assert.equal(validateFinalText(historical, ctx("Сколько вчера стоила Пицца Маргарита?", base), { toolsCalled: ["searchMenu"] }).text, historical);
  const question = "Пицца Маргарита стоит 2100 тг?";
  assert.equal(validateFinalText(question, ctx("Пицца Маргарита стоит 2100 тг?", base), { toolsCalled: ["searchMenu"] }).text, question);
  const quoted = "Клиент написал: «Пицца Маргарита — 2100 тг»";
  assert.equal(validateFinalText(quoted, ctx("Что написал клиент?", base), { toolsCalled: ["searchMenu"] }).text, quoted);
});

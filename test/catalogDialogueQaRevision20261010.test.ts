import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "100";
process.env.REDIS_OPERATION_TIMEOUT_MS = "100";

const { validateFinalText } = await import("../src/agent/finalValidator.js");
const { resolveAgentToolPlan } = await import("../src/agent/toolPolicy.js");
const { createSendMenuLinkSkill } = await import("../src/skills/menuLink.skill.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => { if (redisClient.isOpen) redisClient.destroy(); });

const now = Date.now();
const open = { runtime_available: true, is_accepting_orders: true, within_work_hours: true, is_emergency: false, wait_time: 0 };
const menu = [
  { name: "Маргарита Романа", category_name: "Римская пицца", price: 2200, available: true },
  { name: "Пепперони Классика", category_name: "Классические пиццы", price: 2800, available: true },
  { name: "Лимонная вода", category_name: "Напитки", price: 650, available: true },
];
const ctx = (text: string, extra: any = {}) => ({
  instanceId: "qa-revision-fixture",
  phone: "77000000001",
  text,
  language: "ru",
  config: {},
  fetchedSettings: {},
  activeOrder: null,
  activeShiftNotes: [],
  chatHistory: [],
  menuSnapshot: { items: menu, source: "fixture" },
  menuGrounding: { menu_lookup: "fixture" },
  runtimeStatus: open,
  hardRealtimeContext: open,
  magicLink: "https://fixture.invalid/order",
  magicLinkAlreadySent: false,
  magicLinkGranted: false,
  explicitMenuLinkIntent: false,
  ...extra,
} as any);

test("observed RU and KK preference-selection prompts are removed", () => {
  for (const [language, raw] of [
    ["kk", "Сізге қайсысы ұнайды?"],
    ["ru", "А какая вам больше нравится?"],
  ]) {
    const result = validateFinalText(raw, ctx("Какие пиццы у вас есть?", { language }), { toolsCalled: ["searchMenu", "sendMenuLink"] });
    assert.notEqual(result.text, raw);
    assert.ok(result.warnings.includes("menu_selection_question_removed"));
  }
});

test("order-taking collection questions are removed instead of interviewing for an order", () => {
  for (const [language, raw] of [
    ["kk", "Қай мекенжайға тапсырыс бересіз?"],
    ["kk", "Қай мекенжайға жеткізу керек?"],
    ["kk", "Неше дана керек?"],
    ["kk", "Қалай төлейсіз?"],
    ["ru", "Куда доставить заказ?"],
    ["ru", "На какой адрес доставить заказ?"],
    ["ru", "Сколько штук вам нужно?"],
    ["ru", "Как будете оплачивать?"],
  ]) {
    const result = validateFinalText(raw, ctx("Хочу посмотреть пиццы", { language }), { toolsCalled: ["searchMenu", "sendMenuLink"] });
    assert.notEqual(result.text, raw);
    assert.ok(result.warnings.includes("menu_selection_question_removed"), raw);
  }
});

test("informational, safety, incident, size and wait clarifications remain", () => {
  for (const [language, raw] of [
    ["ru", "Где находится ресторан?"],
    ["kk", "Мекенжайыңыз қандай?"],
    ["kk", "Аллергияңыз бар ма?"],
    ["kk", "Қай мөлшерді тексерейін?"],
    ["ru", "Что именно случилось с заказом?"],
    ["ru", "Сможете подождать 60 минут?"],
  ]) {
    assert.equal(validateFinalText(raw, ctx("Нужна информация", { language }), { toolsCalled: [] }).text, raw);
  }
});

test("category consultation plan and real link skill agree on authorization", async () => {
  const c = ctx("Какие пиццы у вас есть?");
  assert.deepEqual(resolveAgentToolPlan(c).requiredTools.slice(0, 2), ["searchMenu", "sendMenuLink"]);
  const result: any = await createSendMenuLinkSkill(c).execute({ reason: "category consultation" });
  assert.equal(result.allowed, true);
  assert.equal(result.link, c.magicLink);
  assert.equal(c.magicLinkGranted, true);
});

test("scoped alternative plan and real link skill agree on authorization", async () => {
  const c = ctx("а ещё?", {
    chatHistory: [{
      role: "user",
      text: "Хочу посмотреть пиццу",
      instanceId: "qa-revision-fixture",
      phone: "77000000001",
      createdAt: now - 1000,
    }],
  });
  assert.deepEqual(resolveAgentToolPlan(c).requiredTools.slice(0, 2), ["searchMenu", "sendMenuLink"]);
  assert.equal((await createSendMenuLinkSkill(c).execute({ reason: "more category options" }) as any).allowed, true);
});

test("category link authorization preserves closure and wait-consent gates", async () => {
  const closed = { ...open, is_accepting_orders: false, is_emergency: true };
  const closedCtx = ctx("Какие пиццы у вас есть?", { runtimeStatus: closed, hardRealtimeContext: closed });
  assert.ok(!resolveAgentToolPlan(closedCtx).requiredTools.includes("sendMenuLink"));
  assert.equal((await createSendMenuLinkSkill(closedCtx).execute({ reason: "category consultation" }) as any).reason, "kitchen_closed");

  const waiting = { ...open, wait_time: 90 };
  const waitingCtx = ctx("Какие пиццы у вас есть?", { runtimeStatus: waiting, hardRealtimeContext: waiting });
  assert.ok(!resolveAgentToolPlan(waitingCtx).requiredTools.includes("sendMenuLink"));
  assert.equal((await createSendMenuLinkSkill(waitingCtx).execute({ reason: "category consultation" }) as any).reason, "wait_consent_required");
});

test("complaints and cross-tenant history cannot authorize a category link", async () => {
  const complaint = ctx("Пиццы плохие, хочу пожаловаться: заказ испорчен.");
  assert.ok(!resolveAgentToolPlan(complaint).requiredTools.includes("sendMenuLink"));
  const complaintResult: any = await createSendMenuLinkSkill(complaint).execute({ reason: "category word in complaint" });
  assert.equal(complaintResult.allowed, false);
  assert.equal(complaintResult.reason, "link_not_requested");

  const foreign = ctx("есть другие?", {
    chatHistory: [{
      role: "user",
      text: "Хочу посмотреть пиццу",
      instanceId: "other-tenant",
      phone: "77000000001",
      createdAt: now - 1000,
    }],
  });
  assert.ok(!resolveAgentToolPlan(foreign).requiredTools.includes("sendMenuLink"));
  const foreignResult: any = await createSendMenuLinkSkill(foreign).execute({ reason: "foreign history" });
  assert.equal(foreignResult.allowed, false);
  assert.equal(foreignResult.reason, "link_not_requested");
});

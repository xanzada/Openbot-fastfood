import test from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { isMagicLinkRecent, linkInLastBotReply } = await import("../src/utils/linkRecency.js");
const { promisesMenuLink, honorMenuLinkPromise } = await import("../src/agent/linkPromise.js");
const { createSendMenuLinkSkill } = await import("../src/skills/menuLink.skill.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const LINK = "https://prestige.alemi.kz/?phone=77010000077&hash=ab";
const now = Date.now();

function baseCtx(extra: Record<string, unknown> = {}) {
  return {
    instanceId: "prestige",
    phone: "77010000077",
    text: "Бауырым екі пицца екі донер",
    language: "kk",
    magicLink: LINK,
    magicLinkGranted: false,
    magicLinkAlreadySent: false,
    explicitMenuLinkIntent: false,
    hardRealtimeContext: { runtime_available: true },
    runtimeStatus: { is_accepting_orders: true, wait_time: 15 },
    activeShiftNotes: [],
    activeOrder: null,
    chatHistory: [],
    config: {},
    ...extra,
  } as any;
}

// Live case 2026-10-04: link sent ~55 hours earlier, has_sent_link (30 days) said
// "already sent", the tool refused and the reply pointed at a link that never came.
test("a link from days ago is not 'already sent'; minutes ago or on screen is", () => {
  assert.equal(isMagicLinkRecent(now - 55 * 3_600_000, [], now), false);
  assert.equal(isMagicLinkRecent(1, [], now), false);
  assert.equal(isMagicLinkRecent(0, [], now), false);
  assert.equal(isMagicLinkRecent(now - 2 * 60_000, [], now), true);
  assert.equal(isMagicLinkRecent(now - 55 * 3_600_000, [
    { role: "user", text: "мәзір" },
    { role: "assistant", text: "Міне, мәзір:" },
    { role: "assistant", text: LINK },
    { role: "user", text: "рахмет" },
  ], now), true);
  // A URL the guest typed is not our link on screen.
  assert.equal(isMagicLinkRecent(0, [{ role: "user", text: "https://2gis.kz/x" }], now), false);
});

test("'the link below' phrasings are recognised as a promise", () => {
  for (const text of [
    "Төмендегі сілтеме арқылы пицца мен донерді таңдап, тапсырысты оңай рәсімдей аласыз.",
    "Сілтеме арқылы тапсырыс бере аласыз.",
    "Мәзір сілтемесі төменде.",
    "Выберите пиццу и донер по ссылке ниже.",
    "Ссылка ниже 👇",
    "Оформить заказ можно по ссылке.",
  ]) {
    assert.equal(promisesMenuLink(text), true, text);
  }
  for (const text of ["Донер 1590 теңге.", "Меню на сайте есть три вида донера.", "Операторға хабарладым.", "Доставка есть."]) {
    assert.equal(promisesMenuLink(text), false, text);
  }
});

test("the live reply is honoured: the link is granted, not stripped", async () => {
  const ctx = baseCtx({ chatHistory: [
    { role: "assistant", text: "Кешіріңіз, қазір ақпаратты нақтылап жатырмыз." },
    { role: "user", text: "Бауырым екі пицца екі донер" },
  ] });
  const outcome = await honorMenuLinkPromise(ctx, "Төмендегі сілтеме арқылы пицца мен донерді таңдап, тапсырысты оңай рәсімдей аласыз.");
  assert.equal(outcome.action, "granted");
  assert.equal(ctx.magicLinkGranted, true);
});

test("a recent flag alone no longer blocks a promise when the link is not in the last bot reply", async () => {
  const ctx = baseCtx({ magicLinkAlreadySent: true });
  const outcome = await honorMenuLinkPromise(ctx, "Мәзірді жіберемін.");
  assert.equal(outcome.action, "granted");
});

test("right after the link went out, a generic pointer is dropped, the facts stay", async () => {
  const ctx = baseCtx({ magicLinkAlreadySent: true, text: "Донер қанша?", chatHistory: [
    { role: "assistant", text: "Міне, мәзір:" },
    { role: "assistant", text: LINK },
    { role: "user", text: "Донер қанша?" },
  ] });
  assert.equal(linkInLastBotReply(ctx.chatHistory), true);
  const outcome = await honorMenuLinkPromise(ctx, "Донер 1590 теңге. Сілтеме арқылы тапсырыс бере аласыз.");
  assert.equal(outcome.action, "stripped");
  assert.equal((outcome as any).reason, "link_already_sent");
  assert.match((outcome as any).text, /1590/);
  assert.equal(promisesMenuLink((outcome as any).text), false);
  assert.equal(ctx.magicLinkGranted, false);
});

test("if dropping the pointer would leave nothing, the link is resent instead", async () => {
  const ctx = baseCtx({ magicLinkAlreadySent: true, chatHistory: [
    { role: "assistant", text: LINK },
    { role: "user", text: "екі донер" },
  ] });
  const outcome = await honorMenuLinkPromise(ctx, "Төмендегі сілтеме арқылы таңдаңыз.");
  assert.equal(outcome.action, "granted");
});

test("a closed kitchen still never gets a link through a promise", async () => {
  const ctx = baseCtx({ runtimeStatus: { is_accepting_orders: false } });
  const outcome = await honorMenuLinkPromise(ctx, "Төмендегі сілтеме арқылы таңдаңыз. Қазір жабықпыз.");
  assert.equal(outcome.action, "stripped");
  assert.equal(ctx.magicLinkGranted, false);
});

test("the tool grants an order on an old link and refuses only a fresh duplicate", async () => {
  const oldLink = baseCtx({ magicLinkAlreadySent: false, magicLinkEverSent: true });
  const granted = await (createSendMenuLinkSkill(oldLink) as any).execute({ reason: "guest orders 2 pizza 2 doner" });
  assert.equal(granted.allowed, true);
  assert.equal(oldLink.magicLinkGranted, true);

  const fresh = baseCtx({ magicLinkAlreadySent: true, text: "Сағат нешеге дейін жұмыс істейсіздер?" });
  const refused = await (createSendMenuLinkSkill(fresh) as any).execute({ reason: "follow-up" });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "link_already_sent");

  const resend = await (createSendMenuLinkSkill(baseCtx({ magicLinkAlreadySent: true })) as any).execute({ reason: "order", guestAskedToResend: true });
  assert.equal(resend.allowed, true);
});

test("the tool grants a link on direct order intent even if magicLinkAlreadySent is true", async () => {
  for (const text of [
    "Бауырым екі пицца екі донер",
    "донер алғым келеді",
    "тапсырыс берейін",
    "2 донер жасап қойшы",
  ]) {
    const orderingCtx = baseCtx({ magicLinkAlreadySent: true, text });
    const granted = await (createSendMenuLinkSkill(orderingCtx) as any).execute({ reason: "ordering" });
    assert.equal(granted.allowed, true, text);
    assert.equal(orderingCtx.magicLinkGranted, true, text);
  }
});

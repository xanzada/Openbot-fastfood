import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "300";
process.env.REDIS_OPERATION_TIMEOUT_MS = "300";

const ctx = (extra: Record<string, unknown> = {}) => ({
  language: "kk",
  text: "",
  config: {},
  hardRealtimeContext: {},
  runtimeStatus: {},
  activeShiftNotes: [],
  chatHistory: [],
  activeOrder: null,
  ...extra,
}) as any;

test("first substantive turn is greeted once; later turns never restart the greeting", async () => {
  const { validateFinalText, fallbackReply } = await import("../src/agent/finalValidator.js");

  const first = validateFinalText(
    "Иә, пицца мәзірде бар.",
    ctx({ text: "Пицца бар ма?", dialogueStart: true }),
    { toolsCalled: ["searchMenu"] } as any,
  );
  assert.equal(first.text, "Сәлем! Иә, пицца мәзірде бар.");

  const mirrored = validateFinalText(
    "Қайырлы күн! Мәзір сілтемесін жібердім.",
    ctx({ text: "Сәлем, мәзірді жіберіңізші", dialogueStart: true }),
    { toolsCalled: ["sendMenuLink"] } as any,
  );
  assert.match(mirrored.text, /^Сәлем!/u);
  assert.doesNotMatch(mirrored.text, /^Қайырлы күн!/u);

  const unmarked = validateFinalText(
    "Иә, пицца мәзірде бар.",
    ctx({ text: "Пицца бар ма?" }),
    { toolsCalled: ["searchMenu"] } as any,
  );
  assert.equal(unmarked.text, "Иә, пицца мәзірде бар.", "unit callers without a preloaded marker preserve legacy behavior");

  const history = [{ role: "user", text: "Сәлем" }, { role: "assistant", text: "Сәлем!" }];
  const later = validateFinalText(
    "Сәлем! Пицца мәзірде бар.",
    ctx({ text: "ал пицца ше?", chatHistory: history }),
    { toolsCalled: ["searchMenu"] } as any,
  );
  assert.equal(later.text, "Пицца мәзірде бар.");
  assert.equal(fallbackReply(ctx({ text: "Сәлем", chatHistory: history })), "Сұрағыңызды жаза беріңіз.");
  const afterOperator = validateFinalText(
    "Сәлем! Мәзірді жібердім.",
    ctx({ text: "қайта жіберіңізші", chatHistory: [{ role: "operator", text: "Қазір жіберемін." }] }),
    { toolsCalled: ["sendMenuLink"] } as any,
  );
  assert.equal(afterOperator.text, "Мәзірді жібердім.");

  const spoken = [{ role: "assistant", text: "Сәлем!" }];
  for (const [reply, menuItems] of [
    ["Приветствие уже отправлено.", []],
    ["Салам-Пицца есть в меню.", [{ name: "Салам-Пицца", available: true }]],
    ["Салам есть в меню.", [{ name: "Салам", available: true }]],
  ] as const) {
    const guarded = validateFinalText(
      reply,
      ctx({ language: "ru", text: "Что есть?", chatHistory: spoken, menuSnapshot: { items: menuItems } }),
      { toolsCalled: ["searchMenu"] } as any,
    );
    assert.equal(guarded.text, reply, "non-greeting/catalog opener must survive: " + reply);
  }
});

test("production dialogue-start predicate uses loaded outbound history", async () => {
  const { dialogueStartFromHistory } = await import("../src/context/dialogueStart.js");
  assert.equal(dialogueStartFromHistory([]), true);
  assert.equal(dialogueStartFromHistory([{ role: "user", text: "Сәлем" }]), true);
  assert.equal(dialogueStartFromHistory([{ role: "assistant", text: "Сәлем!" }]), false);
  assert.equal(dialogueStartFromHistory([{ role: "operator", text: "Сәлем!" }]), false);

  const preload = await readFile(new URL("../src/context/preloadContext.ts", import.meta.url), "utf8");
  assert.match(preload, /dialogueStart:\s*dialogueStartFromHistory\(chatHistory\)/u);
  const route = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  assert.match(route, /guestGreeting\.pure[\s\S]{0,120}ctx\.dialogueStart\s*===\s*true/u);
});

test("typing presence is awaited before the accepted turn continues", async () => {
  const route = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const transport = await readFile(new URL("../src/transport/whatspro.client.ts", import.meta.url), "utf8");
  assert.match(route, /stopTyping\s*=\s*await\s+startWhatsProTyping\(\{\s*instanceId,\s*phone\s*\}\)/u);
  assert.match(transport, /export\s+async\s+function\s+startWhatsProTyping/u);
  assert.match(transport, /await\s+pulse\(initialDeadlineMs\)/u);
});

test("typing controller does not release the reply path before the first presence settles", async () => {
  const { startWhatsProTyping } = await import("../src/transport/whatspro.client.js");
  let releasePresence: (() => void) | undefined;
  let continued = false;
  let scheduled = 0;
  let cancelled = false;
  const presence = new Promise<void>((resolve) => { releasePresence = resolve; });

  const starting = startWhatsProTyping(
    { instanceId: "restaurant-a", phone: "77000000001" },
    {
      sendPresence: async () => presence,
      schedule: ((callback: () => void, _ms: number) => {
        scheduled += 1;
        return { unref() {}, callback } as any;
      }) as any,
      cancel: (() => { cancelled = true; }) as any,
      initialDeadlineMs: 100,
    },
  );
  void starting.then(() => { continued = true; });
  await Promise.resolve();
  assert.equal(continued, false, "answer path must wait for initial composing acknowledgement");
  assert.equal(scheduled, 0, "refresh loop starts only after the initial attempt");

  releasePresence?.();
  const stop = await starting;
  assert.equal(continued, true);
  assert.equal(scheduled, 1);
  stop();
  assert.equal(cancelled, true);

  const stopAfterFailure = await startWhatsProTyping(
    { instanceId: "restaurant-a", phone: "77000000001" },
    {
      sendPresence: async () => { throw new Error("gateway unavailable"); },
      schedule: (() => ({ unref() {} })) as any,
      cancel: (() => undefined) as any,
    },
  );
  assert.equal(typeof stopAfterFailure, "function", "bounded presence failure must not block replies");
  stopAfterFailure();
});

test("typing deadline covers delayed tenant config and stop aborts a delayed refresh", async () => {
  const { sendWhatsProPresence, startWhatsProTyping } = await import("../src/transport/whatspro.client.js");
  const transport = {
    baseUrl: "https://whatspro.invalid",
    sendUrl: "",
    presenceUrl: "",
    apiToken: "tenant-token",
    source: "tenant_platform",
    tenantFound: true,
  };

  let releaseConfig: ((value: typeof transport) => void) | undefined;
  let posts = 0;
  const delayedConfig = new Promise<typeof transport>((resolve) => { releaseConfig = resolve; });
  const startedAt = Date.now();
  const stopAfterDeadline = await startWhatsProTyping(
    { instanceId: "restaurant-a", phone: "77000000001" },
    {
      initialDeadlineMs: 25,
      sendPresence: (payload, signal) => sendWhatsProPresence(payload, signal, {
        resolveTransport: (async () => delayedConfig) as any,
        post: (async () => { posts += 1; return { data: { success: true } }; }) as any,
      }),
      schedule: (() => ({ unref() {} })) as any,
      cancel: (() => undefined) as any,
    },
  );
  assert.ok(Date.now() - startedAt < 150, "config lookup is inside the initial presence deadline");
  assert.equal(posts, 0);
  releaseConfig?.(transport);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts, 0, "a config that resolves after abort must not create a late POST");
  stopAfterDeadline();

  let refreshCallback: (() => void) | undefined;
  let resolverCalls = 0;
  let releaseRefreshConfig: ((value: typeof transport) => void) | undefined;
  const refreshConfig = new Promise<typeof transport>((resolve) => { releaseRefreshConfig = resolve; });
  posts = 0;
  const stop = await startWhatsProTyping(
    { instanceId: "restaurant-a", phone: "77000000001" },
    {
      initialDeadlineMs: 100,
      refreshDeadlineMs: 20,
      sendPresence: (payload, signal) => sendWhatsProPresence(payload, signal, {
        resolveTransport: (async () => (++resolverCalls === 1 ? transport : refreshConfig)) as any,
        post: (async () => { posts += 1; return { data: { success: true } }; }) as any,
      }),
      schedule: ((callback: () => void) => {
        refreshCallback = callback;
        return { unref() {} } as any;
      }) as any,
      cancel: (() => undefined) as any,
    },
  );
  assert.equal(posts, 1, "initial presence reached the gateway");
  refreshCallback?.();
  await new Promise((resolve) => setTimeout(resolve, 30));
  refreshCallback?.();
  await Promise.resolve();
  assert.equal(resolverCalls, 2, "an aborted slow refresh remains single-flight until config actually settles");
  stop();
  releaseRefreshConfig?.(transport);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(posts, 1, "stop aborts an in-flight refresh before any late POST");
});

test("cancellation reason follows trusted order state instead of guessing", async () => {
  const { buildCancellationNotice, decideCancellationNotice } = await import("../src/services/cancellationNotice.service.js");

  assert.equal(
    buildCancellationNotice("neutral", "kk"),
    "❌ Тапсырысыңыз тоқтатылды. Төлем жасап қойған болсаңыз, осы чатқа жазыңыз — мән-жайды анықтаймыз. Қайта тапсырыс бергіңіз келсе, мәзір сілтемесі арқылы рәсімдей аласыз.",
  );

  assert.equal(decideCancellationNotice({
    reason: "payment timeout",
    reasonCode: "payment_timeout",
    receiptSeen: false,
    notifyCursor: { rank: 1, status: "request_payment" },
  }).kind, "unpaid");

  assert.equal(decideCancellationNotice({
    reason: "",
    receiptSeen: false,
    notifyCursor: { rank: 1, status: "request_payment" },
  }).kind, "neutral");

  assert.equal(decideCancellationNotice({
    reason: "нет оплаты",
    receiptSeen: true,
    notifyCursor: { rank: 1, status: "request_payment" },
  }).kind, "neutral");

  assert.equal(decideCancellationNotice({
    reason: "Тағам бітіп қалды",
    receiptSeen: false,
    notifyCursor: { rank: 0, status: "new_order" },
  }).kind, "out_of_stock");

  assert.equal(decideCancellationNotice({
    reason: "Тағам бітіп қалды",
    receiptSeen: true,
    notifyCursor: { rank: 1, status: "request_payment" },
  }).kind, "neutral", "raw stock wording cannot override receipt-stage facts");

  assert.equal(decideCancellationNotice({
    reason: "payment timeout",
    reasonCode: "payment_timeout",
    receiptSeen: false,
    notifyCursor: null,
    evidenceAvailable: false,
  }).kind, "neutral", "unpaid still requires known no-receipt and payment-request evidence");

  assert.equal(decideCancellationNotice({
    reason: "оплата не поступила",
    receiptSeen: false,
    notifyCursor: { rank: 1, status: "request_payment" },
    evidenceAvailable: false,
  }).kind, "neutral", "Redis failure cannot turn unknown receipt state into unpaid");

  assert.equal(decideCancellationNotice({
    reason: "Заказ не оплачен",
    receiptSeen: false,
    notifyCursor: { rank: 1, status: "request_payment" },
    evidenceAvailable: true,
  }).kind, "unpaid", "a simple negated payment state is not affirmative payment evidence");

  assert.equal(decideCancellationNotice({
    reason: "Не оплачен? Нет, оплата поступила.",
    receiptSeen: false,
    notifyCursor: { rank: 1, status: "request_payment" },
    evidenceAvailable: true,
  }).kind, "neutral", "contradictory free text cannot become an unpaid claim");

  for (const reason of [
    "Заказ не оплачен, но заказ уже оплачен.",
    "Не оплачен? Нет, он уже оплачен.",
    "Не оплачен. Клиент уже оплатил.",
  ]) {
    assert.equal(decideCancellationNotice({
      reason,
      receiptSeen: false,
      notifyCursor: { rank: 1, status: "request_payment" },
      evidenceAvailable: true,
    }).kind, "neutral", "affirmative payment must override an earlier unpaid phrase");
  }

  assert.equal(decideCancellationNotice({
    reason: "Тағам бітіп қалды",
    receiptSeen: false,
    notifyCursor: { rank: 0, status: "new_order" },
    evidenceAvailable: false,
  }).kind, "neutral", "Redis failure cannot turn unknown order stage into stock-out");

  assert.equal(decideCancellationNotice({
    reason: "Тағам бітіп қалды",
    receiptSeen: false,
    notifyCursor: null,
  }).kind, "neutral", "missing cursor is unknown stage, not pre-payment proof");

  assert.equal(decideCancellationNotice({
    reason: "",
    receiptSeen: false,
    notifyCursor: null,
  }).kind, "neutral");

  assert.equal(decideCancellationNotice({
    reason: "unknown",
    reasonCode: "out_of_stock",
    receiptSeen: true,
    notifyCursor: { rank: 1, status: "request_payment" },
  }).kind, "out_of_stock");
});

test("strict cancellation evidence reports Redis lookup failure as unknown", async () => {
  const { getOrderCancellationEvidence, redisClient } = await import("../src/services/redis.service.js");
  const evidence = await getOrderCancellationEvidence("restaurant-a", "104");
  assert.deepEqual(evidence, { available: false, receiptSeen: false, notifyCursor: null });
  if (redisClient.isOpen) redisClient.destroy();
});

test("same order id can resolve differently only from tenant-scoped facts", async () => {
  const { decideCancellationNotice } = await import("../src/services/cancellationNotice.service.js");
  const { receiptSeenKey } = await import("../src/services/redis.service.js");

  assert.notEqual(receiptSeenKey("restaurant-a", "104"), receiptSeenKey("restaurant-b", "104"));
  const restaurantA = decideCancellationNotice({
    reason: "payment timeout",
    reasonCode: "payment_timeout",
    receiptSeen: false,
    notifyCursor: { rank: 1, status: "request_payment" },
  });
  const restaurantB = decideCancellationNotice({
    reason: "",
    receiptSeen: true,
    notifyCursor: { rank: 1, status: "request_payment" },
  });
  assert.equal(restaurantA.kind, "unpaid");
  assert.equal(restaurantB.kind, "neutral");
});

test("Kazakh reply guard removes order-taking and selection prompts without dish hardcoding", async () => {
  const { validateFinalText } = await import("../src/agent/finalValidator.js");
  const base = ctx({
    text: "пицца бар ма",
    menuSnapshot: { items: [{ name: "Маргарита", available: true }] },
  });

  const question = validateFinalText(
    "Маргарита бар. Қайсысын алғыңыз келеді?",
    base,
    { toolsCalled: ["searchMenu"] } as any,
  );
  assert.doesNotMatch(question.text, /алғыңыз\s+келеді/u);
  assert.ok(question.warnings.includes("menu_selection_question_removed"));

  const stance = validateFinalText(
    "Тапсырысыңызды орналастыруға дайынмын.",
    base,
    { toolsCalled: ["searchMenu"] } as any,
  );
  assert.doesNotMatch(stance.text, /орналастыруға\s+дайынмын/u);
  assert.match(stance.text, /сілтемесі\s+арқылы/u);
});


test("confirmed stock cancellation is deterministic and presence audit never logs a raw phone", async () => {
  const kanban = await readFile(new URL("../src/controllers/kanban.ts", import.meta.url), "utf8");
  assert.doesNotMatch(kanban, /humanizeCancellationReason\(cancellationReason/u);
  assert.match(kanban, /buildCancellationNotice\(cancellation\.kind, lang\)/u);

  const transport = await readFile(new URL("../src/transport/whatspro.client.ts", import.meta.url), "utf8");
  const audit = transport.match(/auditError\("WhatsPro presence skipped"[\s\S]*?\n\s*\}\);/u)?.[0] || "";
  assert.match(audit, /maskedPhone:\s*maskPhone\(payload\.phone\)/u);
  assert.doesNotMatch(audit, /\n\s*phone:\s*payload\.phone/u);
});

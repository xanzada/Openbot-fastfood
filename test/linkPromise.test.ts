import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { promisesMenuLink, stripMenuLinkPromise, honorMenuLinkPromise } = await import("../src/agent/linkPromise.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

// The owner's report, 2026-08-28: "меню жіберемін деп айтады, жібермейді". The model
// announced the menu and nothing arrived, because the tool refused on a keyword flag
// the guest's phrasing never set. Detection has to cover how people actually write.
test("the sentences a model really writes are recognised as a promise", () => {
  for (const text of [
    "Мәзірді жіберемін.",
    "Сілтемені қазір жіберемін.",
    "Мәзір жібердім, қарап көріңіз.",
    "Жақсы, сілтемені жіберіп жатырмын.",
    "Сейчас отправлю ссылку.",
    "Отправляю вам меню.",
    "Ссылку скину сейчас.",
    "Пришлю ссылку через минуту.",
    "Ссылка отправлена.",
  ]) {
    assert.equal(promisesMenuLink(text), true, text);
  }
});

test("an answer that promises nothing is left alone", () => {
  for (const text of [
    "Донер 1590 теңге.",
    "Иә, жұмыс істеп тұрмыз.",
    "Операторға хабарладым.",
    "Меню на сайте есть три вида донера.",
    "Доставка есть.",
  ]) {
    assert.equal(promisesMenuLink(text), false, text);
  }
});

test("stripping removes only the promise, keeping every real fact", () => {
  const text = "Донер 1590 теңге. Мәзірді жіберемін. Жеткізу 30 минут.";
  const kept = stripMenuLinkPromise(text);

  assert.equal(kept.includes("1590"), true);
  assert.equal(kept.includes("30 минут"), true);
  assert.equal(promisesMenuLink(kept), false);
});

// A granted link needs no repair: the transport is already going to deliver it.
test("a promise backed by a granted link is left exactly as written", async () => {
  const ctx = {
    instanceId: "kabab-1",
    phone: "77010000001",
    language: "kk",
    magicLink: "https://kebab1.alemi.kz/?phone=77010000001&hash=ab",
    magicLinkGranted: true,
    hardRealtimeContext: { runtime_available: true },
    runtimeStatus: {},
    activeShiftNotes: [],
    config: {},
  } as any;

  assert.deepEqual(await honorMenuLinkPromise(ctx, "Мәзірді жіберемін."), { action: "none" });
});

// The whole point: a promise the tool never granted is HONORED, not silently dropped,
// whenever the restaurant can actually sell right now.
test("an unbacked promise mints the link instead of leaving the guest waiting", async () => {
  const ctx = {
    instanceId: "kabab-1",
    phone: "77010000002",
    language: "kk",
    magicLink: null,
    magicLinkGranted: false,
    hardRealtimeContext: { runtime_available: true },
    runtimeStatus: { is_accepting_orders: true, wait_time: 15 },
    activeShiftNotes: [],
    config: {},
  } as any;
  // Redis is unreachable in this suite, so the mark* calls fall through; the link
  // itself is what the guest needs and what the transport reads.
  const outcome = await honorMenuLinkPromise(ctx, "Жақсы, мәзірді жіберемін.");

  // Without a reachable hub the mint fails, and then the promise MUST come out of the
  // text - the one thing that must never happen is an unbacked promise surviving.
  if (outcome.action === "granted") {
    assert.equal(ctx.magicLinkGranted, true);
    assert.ok(ctx.magicLink);
  } else {
    assert.equal(outcome.action, "stripped");
    assert.equal(promisesMenuLink((outcome as any).text), false);
  }
});

test("a closed kitchen never lets a promise smuggle a link out", async () => {
  const ctx = {
    instanceId: "kabab-1",
    phone: "77010000003",
    language: "kk",
    magicLink: null,
    magicLinkGranted: false,
    hardRealtimeContext: { runtime_available: true },
    runtimeStatus: { is_accepting_orders: false },
    activeShiftNotes: [],
    config: {},
  } as any;
  const outcome = await honorMenuLinkPromise(ctx, "Мәзірді жіберемін.");

  assert.equal(outcome.action, "stripped");
  assert.equal((outcome as any).reason, "kitchen_closed");
  assert.equal(ctx.magicLinkGranted, false);
  assert.equal(ctx.magicLink, null);
});

test("an unreachable kitchen is treated the same way", async () => {
  const ctx = {
    instanceId: "kabab-1",
    phone: "77010000004",
    language: "ru",
    magicLink: null,
    magicLinkGranted: false,
    hardRealtimeContext: { runtime_available: false },
    activeOrder: null,
    runtimeStatus: {},
    activeShiftNotes: [],
    config: {},
  } as any;
  const outcome = await honorMenuLinkPromise(ctx, "Сейчас отправлю ссылку.");

  assert.equal(outcome.action, "stripped");
  assert.equal((outcome as any).reason, "runtime_unavailable");
});

test("the agent wires the check in after every rewrite, before delivery", async () => {
  const source = await readFile(new URL("../src/agent/fastfoodAgent.ts", import.meta.url), "utf8");

  assert.match(source, /honorMenuLinkPromise\(ctx, finalText\)/);
  // It must sit after the critic block, or a rewritten reply could reintroduce the
  // promise unchecked.
  assert.ok(source.indexOf("critic_regenerated") < source.indexOf("honorMenuLinkPromise(ctx, finalText)"));
  // And before hasLink is computed, since granting flips magicLinkGranted.
  assert.ok(source.indexOf("honorMenuLinkPromise(ctx, finalText)") < source.indexOf("hasLink: Boolean(ctx.magicLinkGranted"));
});

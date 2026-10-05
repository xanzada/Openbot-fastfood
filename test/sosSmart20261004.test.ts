import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { answerAgentFailure, isCalmCatalogTurn, catalogPriceLines } = await import("../src/services/turnSafetyNet.service.js");
const { redisClient } = await import("../src/services/redis.service.js");
test.after(() => { if (redisClient.isOpen) redisClient.destroy(); });

const routed: any[] = [];
const route = (action: string) => (async (_ctx: any, input: any) => { routed.push(input); return { action } as any; }) as any;
const linkOk = async (ctx: any) => { ctx.magicLinkGranted = true; ctx.magicLink = "https://x.kz/?phone=1&hash=a"; return true; };
const linkBlocked = async () => false;
const items = [
  { name: "Пицца Маргарита", price: 2500, category: "Пицца" },
  { name: "Пицца Пепперони", price: 2900, category: "Пицца" },
  { name: "Донер комбо", price: 1800, category: "Донер" },
  { name: "Пицца 4 сезона", price: 2500, category: "Пицца", available: false },
];
const ctx = (text: string, language: "kk" | "ru" = "kk", extra: Record<string, unknown> = {}) =>
  ({ text, language, instanceId: "t", phone: "77000000000", menuSnapshot: { items }, activeOrder: null, ...extra }) as any;

// Live 2026-10-04: «пицца қаншадан?» + model timeout = red high-urgency SOS about nothing.
test("a price question during a model outage is answered from the menu, with no SOS", async () => {
  routed.length = 0;
  const c = ctx("Ассалаумағалейкум брат, пицца керек еді, пицца, пицца қаншадан?");
  const reply = await answerAgentFailure(c, new Error("TEXT_MODEL_TIMEOUT:gemini:20000ms"), route("operator_case_created"), linkOk);
  assert.equal(routed.length, 0, "no operator case");
  assert.match(reply, /Пицца Маргарита — 2500 ₸/);
  assert.match(reply, /Пицца Пепперони — 2900 ₸/);
  assert.doesNotMatch(reply, /4 сезона/, "sold-out dishes are not offered");
  assert.match(reply, /төмендегі сілтемеде/);
  assert.equal(c.magicLinkGranted, true);
  assert.doesNotMatch(reply, /Оператор/);
});

test("an order intent without a priced match gets the link, still no SOS", async () => {
  routed.length = 0;
  const reply = await answerAgentFailure(ctx("Хочу заказать", "ru"), new Error("x"), route("operator_case_created"), linkOk);
  assert.equal(routed.length, 0);
  assert.match(reply, /по ссылке ниже/);
});

test("prices without a link never promise a link below", async () => {
  routed.length = 0;
  const reply = await answerAgentFailure(ctx("донер комбо канша?"), new Error("x"), route("operator_case_created"), linkBlocked);
  assert.equal(routed.length, 0);
  assert.match(reply, /Донер комбо — 1800 ₸/);
  assert.doesNotMatch(reply, /төмендегі/);
});

test("nothing factual to say (closed kitchen, no match) falls back to the old SOS path", async () => {
  routed.length = 0;
  const reply = await answerAgentFailure(ctx("мәзір бар ма?"), new Error("x"), route("operator_case_created"), linkBlocked);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].source, "ai_unavailable");
  assert.match(reply, /Оператор/);
});

test("complaints, late/missing orders, people and money still raise the SOS", async () => {
  for (const text of [
    "Тапсырысым қайда?",
    "где мой заказ",
    "Донер суық келді, елу минут күттім",
    "оператормен сөйлесейін",
    "верните деньги за заказ",
    "заказ неправильный привезли",
  ]) {
    assert.equal(isCalmCatalogTurn(ctx(text)), false, text);
    routed.length = 0;
    await answerAgentFailure(ctx(text), new Error("x"), route("operator_case_created"), linkOk);
    assert.equal(routed.length, 1, text);
  }
  assert.equal(isCalmCatalogTurn(ctx("Тапсырысым қанша болды?", "kk", { activeOrder: { id: 1 } })), false, "a live order question is not catalog talk");
  assert.equal(isCalmCatalogTurn(ctx("мәзір", "kk", { mediaContext: { kind: "image" } })), false, "a photo is not catalog talk");
  assert.equal(isCalmCatalogTurn(ctx("пицца қанша", "kk", { mediaContext: { kind: "audio" } })), true, "a voice note is");
});

test("price lines come only from the catalog", () => {
  assert.deepEqual(catalogPriceLines(ctx("сколько стоит суши?", "ru")), []);
  assert.equal(catalogPriceLines(ctx("Бауырым екі пицца екі донер")).length, 3);
});

test("a model timeout never sells a dish blocked by an active operator note", async () => {
  routed.length = 0;
  let linkCalls = 0;
  const c = ctx("Цезарь керек онда", "kk", {
    activeShiftNotes: [{ noteId: "note-sushi", text: "суши нет пока что" }],
    menuSnapshot: { items: [{ name: "Цезарь", category: "Суши", price: 3000, available: true }] },
  });
  const reply = await answerAgentFailure(
    c,
    new Error("TEXT_MODEL_TIMEOUT:gemini-3.6-flash:20000ms"),
    route("operator_case_created"),
    async () => { linkCalls += 1; return true; },
  );
  assert.equal(routed.length, 0);
  assert.equal(linkCalls, 0, "an ordering link must not be granted for the blocked dish");
  assert.doesNotMatch(reply, /3000|сілтеме|https?:/iu);
  assert.match(reply, /қолжетімсіз/iu);
  assert.deepEqual(catalogPriceLines(c), []);
});

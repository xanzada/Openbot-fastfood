import test from "node:test";
import assert from "node:assert/strict";
import { dialogueStartFromHistory } from "../src/context/dialogueStart.js";
import { alignGreetingReply, fallbackReply } from "../src/agent/greeting.js";
import { isShoppingDecision, reduceShoppingConstraints } from "../src/services/shoppingConstraints.service.js";
import { isAlternativeMenuFollowUp } from "../src/utils/menuQuestionContext.js";
import { createSearchMenuSkill, groundMenuTurn } from "../src/skills/searchMenu.skill.js";
import { validateFinalText } from "../src/agent/finalValidator.js";
import type { FastFoodContext } from "../src/context/types.js";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "300";
process.env.REDIS_OPERATION_TIMEOUT_MS = "300";

const menu = {
  source: "dle_spa_items",
  count: 8,
  items: [
    { name: "Лаванда", price: 3000, category_name: "Основное", composition: "рис, огурец", available: true },
    { name: "Орбита", price: 6000, category_name: "Основное", composition: "рис, морковь", available: true },
    { name: "Вектор", price: 3500, category_name: "Основное", composition: "курица, рис", available: true },
    { name: "Комета", price: 2000, category_name: "Основное", composition: "курица", available: true },
    { name: "Пульсар", price: 2500, category_name: "Основное", composition: "Комета, рис", available: true },
    { name: "Туман", price: 1500, category_name: "Основное", composition: "", available: true },
    { name: "Сигма", price: 1800, category_name: "Основное", composition: "рис", available: false },
    { name: "Гамма", price: 2000, category_name: "Тәттілер", composition: "рис", available: false },
  ],
};

function context(text: string, extra: Partial<FastFoodContext> = {}): FastFoodContext {
  return {
    instanceId: "fixture-tenant-a", phone: "fixture-01", text, language: "kk",
    config: {}, senderMeta: {}, languagePolicy: {}, runtimeStatus: { runtime_available: true, is_accepting_orders: true },
    fetchedSettings: {}, hardRealtimeContext: {}, activeOrder: null, chatHistory: [],
    activeShiftNotes: [{ id: "fixture-note", text: "Комета недоступна", expiresAt: Date.now() + 60_000 }],
    menuSnapshot: menu, mediaContext: null, ...extra,
  } as FastFoodContext;
}
function constrained(text: string, avoidMeat = true): FastFoodContext {
  const ctx = context(text);
  ctx.shoppingConstraints = reduceShoppingConstraints({ ...ctx, text: "Бюджет 5000 тг." + (avoidMeat ? " Без мяса." : "") }, null);
  return ctx;
}
const names = (result: Record<string, any>) => result.items.map((item: { name: string }) => item.name);
async function search(ctx: FastFoodContext, query = "old-empty-scope", category?: string) {
  return createSearchMenuSkill(ctx, async (tenant, _domain, _language, options) => {
    assert.equal(tenant, ctx.instanceId);
    assert.equal(options?.forceFresh, true);
    return menu;
  }).execute!({ query, ...(category ? { category } : {}) }, {} as any) as Promise<Record<string, any>>;
}

test("eight-hour greeting session ignores the current incoming row when finding the last outbound", () => {
  const now = Date.now();
  const history = [{ role: "assistant", text: "old", createdAt: now - 8 * 60 * 60_000 - 1 }, { role: "user", text: "current", createdAt: now }];
  assert.equal(dialogueStartFromHistory(history), true);
});

test("real explicit KK greeting after eight hours keeps reciprocal greeting and live options under5000", async () => {
  const now = Date.now();
  const ctx = constrained("Ассалаумағалейкум брат, нема жейтін не бар? 5000 теңгеге не келеді?", false);
  ctx.chatHistory = [{ role: "assistant", text: "old", createdAt: now - 8 * 60 * 60_000 - 1 }];
  ctx.dialogueStart = dialogueStartFromHistory(ctx.chatHistory);
  const result = await groundMenuTurn(ctx, async () => menu);
  assert.ok(result.items.length, "general food/budget inquiry must be grounded in the live catalogue");
  const reply = validateFinalText("Лаванда — 3000 тг.", ctx, { toolsCalled: ["searchMenu"] });
  assert.match(reply.text, /^Уағалейкум ассалам!/u);
  assert.match(reply.text, /3000/u);
  assert.doesNotMatch(reply.text, /6000|нұсқа табылмады/u);
});

test("current explicit greeting is reciprocal during a known active dialogue", () => {
  const ctx = context("Сәлем, мәзірді көрсетіңізші", { dialogueStart: false, chatHistory: [{ role: "assistant", text: "old", createdAt: Date.now() - 1000 }] });
  assert.match(alignGreetingReply("Қайырлы күн! Қазіргі мәзір.", ctx).text, /^Сәлем!/u);
  assert.match(fallbackReply(ctx), /^Сәлем!/u);
});

test("recent ordinary continuation removes an unsolicited greeting", () => {
  const ctx = context("Бағасын айтыңызшы", { dialogueStart: false, chatHistory: [{ role: "assistant", text: "recent", createdAt: Date.now() - 1000 }] });
  assert.equal(dialogueStartFromHistory(ctx.chatHistory), false);
  assert.equal(alignGreetingReply("Сәлем! Бағасы 3000 тг.", ctx).text, "Бағасы 3000 тг.");
});

test("missing malformed and future outbound timestamps do not invent an idle reset", () => {
  for (const createdAt of [undefined, "not-a-date", Date.now() + 60_000]) {
    assert.equal(dialogueStartFromHistory([{ role: "assistant", createdAt }]), false);
  }
});

test("Kazakh menu availability is browse rather than a shopping restriction decision", () => {
  assert.equal(isShoppingDecision(context("Мәзірде не бар?")), false);
  assert.equal(isShoppingDecision(context("5000 теңгеге не келеді?")), true);
});

for (const text of ["тағы не бар", "Одан басқа не бар?"]) {
  test("current broad alternative grammar recognizes " + text, () => assert.equal(isAlternativeMenuFollowUp(text), true));
  test("empty scoped " + text + " recovers only live budget/diet/note-permitted options", async () => {
    const result = await search(constrained(text));
    assert.deepEqual(names(result), ["Лаванда"]);
    assert.deepEqual(result.eligible_choices.map((item: { name: string }) => item.name), ["Лаванда"]);
    assert.deepEqual(result.shopping_constraints.eligible_items.map((item: { name: string }) => item.name), ["Лаванда"]);
    assert.equal(result.shopping_constraints.budget, 5000);
    assert.equal(result.shopping_constraints.avoid_meat, true);
  });
}

test("inherited empty category may widen for an unscoped alternative but current explicit category may not", async () => {
  const ctx = constrained("Одан басқа не бар?");
  ctx.chatHistory = [{ role: "user", text: "Тәттілерде не бар?", createdAt: Date.now() - 1000 }];
  assert.deepEqual(names(await search(ctx)), ["Лаванда"]);
  assert.deepEqual(names(await search(constrained("Тәттілерде не бар?"), "", "Тәттілер")), []);
});

test("nonempty scoped result is retained without full-catalog expansion", async () => {
  const result = await search(constrained("Одан басқа не бар?"), "Лаванда");
  assert.deepEqual(names(result), ["Лаванда"]);
  assert.equal(result.browse_scope, undefined);
});

test("specific absent dish and composition questions stay narrow", async () => {
  for (const text of ["Зета999 бар ма?", "Зета999 ішінде не бар?", "5000 теңгеге Зета999 бар ма?"]) {
    assert.deepEqual(names(await search(constrained(text), "Зета999")), [], text);
  }
});

test("fresh complete catalogue beyond the preload preview is read once and reused within this turn", async () => {
  const ctx = constrained("Одан басқа не бар?");
  const full = { source: "dle_spa_items", count: 66, items: [...Array.from({ length: 65 }, (_, i) => ({ name: "Closed" + i, price: 1000, composition: "рис", available: false })), menu.items[0]] };
  ctx.menuSnapshot = { source: full.source, items: full.items.slice(0, 60) };
  let reads = 0;
  const reader = async (tenant: string) => { assert.equal(tenant, ctx.instanceId); reads++; return full; };
  const result = await groundMenuTurn(ctx, reader);
  assert.deepEqual(names(result), ["Лаванда"]);
  await createSearchMenuSkill(ctx, reader).execute!({ query: "" }, {} as any);
  assert.equal(reads, 1);
});

test("unavailable live menu remains unknown and has no broadened candidates", async () => {
  const ctx = constrained("Одан басқа не бар?");
  const result = await groundMenuTurn(ctx, async () => ({ source: "menu_unavailable", items: [] }));
  assert.equal(result.menu_lookup, "unavailable");
  assert.deepEqual(names(result), []);
});

test("reported quotes and overflow with a late specific subject do not authorize broad expansion", async () => {
  for (const text of ["Он сказал «Мәзірде не бар?»", "Мәзірде не бар? " + "x".repeat(4096) + " Зета999 бар ма?"]) {
    assert.deepEqual(names(await search(constrained(text))), []);
  }
});

test("broad recovery passes only the current tenant to the live reader", async () => {
  for (const tenant of ["fixture-tenant-a", "fixture-tenant-b"]) {
    const ctx = constrained("Одан басқа не бар?"); ctx.instanceId = tenant;
    ctx.shoppingConstraints = reduceShoppingConstraints({ ...ctx, text: "Бюджет 5000 тг." }, null);
    const result = await groundMenuTurn(ctx, async (requested) => {
      assert.equal(requested, tenant);
      return { source: "dle_spa_items", count: 1, items: [{ name: tenant, price: 3000, composition: "рис", available: true }] };
    });
    assert.deepEqual(names(result), [tenant]);
  }
});

test("eight-hour session boundary uses the newest valid outbound timestamp and normalized roles", () => {
  const now = 1_800_000_000_000;
  for (const role of ["assistant", " Model ", "BOT", "operator"]) {
    assert.equal(dialogueStartFromHistory([{ role, timestamp: new Date(now - 8 * 60 * 60_000).toISOString() }], now), true);
    assert.equal(dialogueStartFromHistory([{ role, timestamp: now - 8 * 60 * 60_000 + 1 }], now), false);
  }
  assert.equal(dialogueStartFromHistory([{ role: "assistant", createdAt: now - 9 * 60 * 60_000 }, { role: "operator", createdAt: now - 1000 }], now), false);
});

test("blocked historical item keeps a nonempty category scoped and only eligible choices, while an empty item search may recover", async () => {
  const ctx = constrained("Одан басқа не бар?");
  ctx.chatHistory = [{ role: "user", text: "Комета бар ма?", instanceId: ctx.instanceId, phone: ctx.phone, createdAt: Date.now() - 1000 }];
  const result = await groundMenuTurn(ctx, async () => menu);
  assert.equal(result.browse_scope, undefined, "a nonempty inherited category must not expand");
  assert.ok(!names(result).some((name: string) => ["Комета", "Пульсар", "Сигма"].includes(name)));
  assert.deepEqual(result.eligible_choices.map((item: { name: string }) => item.name), ["Лаванда"]);
  assert.equal(result.shopping_constraints.budget, 5000);
  assert.equal(result.shopping_constraints.avoid_meat, true);
  assert.deepEqual(names(await search(constrained("Одан басқа не бар?"), "Комета")), ["Лаванда"]);
});

test("explicit stale or backup catalogue markers cannot authorize broad recovery", async () => {
  for (const markers of [{ stale: true }, { is_stale: true }, { stale_menu_backup: true }, { source: "stale_menu_backup" }]) {
    const ctx = constrained("Одан басқа не бар?");
    const result = await groundMenuTurn(ctx, async () => ({ ...menu, ...markers }));
    assert.deepEqual(names(result), []);
  }
});

test("unknown prior shopping state cannot silently drop remembered restrictions during recovery", async () => {
  const ctx = constrained("Одан басқа не бар?");
  ctx.shoppingPriorStateUnknown = true;
  assert.deepEqual(names(await search(ctx)), []);
});

for (const text of ["тағы не бар", "Одан басқа не бар?", "Мәзірде не бар?"]) {
  test("remembered budget constrains a final recommendation on semantic browse: " + text, async () => {
    const ctx = constrained(text, false);
    assert.equal(isShoppingDecision(ctx), false);
    await groundMenuTurn(ctx, async () => menu);
    const reply = validateFinalText("Орбита — 6000 тг. Оны ұсынамын.", ctx, { toolsCalled: ["searchMenu"] });
    assert.doesNotMatch(reply.text, /Орбита|6000/u);
    assert.match(reply.text, /3000/u);
    assert.ok(reply.warnings.includes("budget_alternatives_grounded"));
  });
  test("remembered meat restriction constrains a final recommendation on semantic browse: " + text, async () => {
    const ctx = constrained(text);
    assert.equal(isShoppingDecision(ctx), false);
    await groundMenuTurn(ctx, async () => menu);
    const reply = validateFinalText("Вектор — 3500 тг. Оны ұсынамын.", ctx, { toolsCalled: ["searchMenu"] });
    assert.doesNotMatch(reply.text, /Вектор|3500/u);
    assert.match(reply.text, /Лаванда/u);
  });
}

test("known partial catalogue cannot widen an empty search past missing nested composition references", async () => {
  const ctx = constrained("Одан басқа не бар?");
  const partial = { source: "dle_spa_items", count: 7, items: [{ name: "Лаванда", price: 3000, category_name: "Основное", composition: "Комета", available: true }] };
  const result = await createSearchMenuSkill(ctx, async () => partial).execute!({ query: "old-empty-scope" }, {} as any) as Record<string, any>;
  assert.equal(result.browse_scope, undefined);
  assert.deepEqual(names(result), []);
  assert.deepEqual(result.eligible_choices, []);
});

test("unproved catalogue completeness cannot authorize current_complete_menu widening", async () => {
  for (const count of [undefined, "8", -1, 8.5, Number.NaN]) {
    const ctx = constrained("Одан басқа не бар?");
    const result = await createSearchMenuSkill(ctx, async () => ({ ...menu, count })).execute!({ query: "old-empty-scope" }, {} as any) as Record<string, any>;
    assert.equal(result.browse_scope, undefined);
    assert.deepEqual(names(result), []);
  }
});

test("named price facts remain factual even above remembered budget", async () => {
  const ctx = constrained("Орбита қанша тұрады?", false);
  await groundMenuTurn(ctx, async () => menu);
  const reply = validateFinalText("Орбита — 6000 тг.", ctx, { toolsCalled: ["searchMenu"] });
  assert.match(reply.text, /Орбита.*6000/u);
  assert.ok(!reply.warnings.includes("budget_alternatives_grounded"));
});

test("final browse constraints use full composition references without widening the grounded category", async () => {
  const ctx = constrained("Одан басқа не бар?");
  ctx.activeShiftNotes = [];
  const live = { source: "dle_spa_items", count: 4, items: [
    { name: "Лаванда", price: 3000, category_name: "Основное", composition: "Комета", available: true },
    { name: "Комета", price: 1000, category_name: "Компоненты", composition: "тауық еті", available: true },
    { name: "Орхидея", price: 2800, category_name: "Основное", composition: "рис", available: true },
    { name: "Ирис", price: 4000, category_name: "Десерты", composition: "рис", available: true },
  ] };
  const result = await createSearchMenuSkill(ctx, async () => live).execute!({ query: "Основное", category: "Основное" }, {} as any) as Record<string, any>;
  ctx.menuGrounding = { ...result, lookup_query: "Основное" };
  const reply = validateFinalText("Лаванда — 3000 тг. Оны ұсынамын.", ctx, { toolsCalled: ["searchMenu"] });
  assert.match(reply.text, /Орхидея/u);
  assert.doesNotMatch(reply.text, /Лаванда|Комета|Ирис/u);
});

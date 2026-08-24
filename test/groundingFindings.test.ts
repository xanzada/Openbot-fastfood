import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient } = await import("../src/services/redis.service.js");
test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const { validateFinalText } = await import("../src/agent/finalValidator.js");
const { hasExplicitMenuLinkIntent } = await import("../src/utils/magicLink.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// A grounding gate must ask what a tool FOUND, not whether it ran. Every defect in this
// file is the same mistake in a different place, all found 2026-08-22 by re-auditing the
// tree after the previous eleven waves.

const ctx = (over: Record<string, any> = {}) => ({
  instanceId: "grounding-probe",
  language: "ru",
  customerPhone: "77000000000",
  phone: "77000000000",
  config: {},
  runtimeStatus: { is_accepting_orders: true },
  hardRealtimeContext: { stale: false },
  fetchedSettings: { wait_time: 0 },
  menuSnapshot: { items: [{ name: "Пицца", price: 2500 }] },
  activeShiftNotes: [],
  activeOrder: null,
  chatHistory: [],
  ...over,
}) as any;

// ---------------------------------------------------------------------------- A39
// The worst of the batch: the most idiomatic Russian allergen answer walked straight
// through the one gate that exists to stop it.
test("an allergen assurance is cut whichever side the negation falls on", () => {
  // Kazakh is SOV, so "жаңғақ жоқ" (term, then negation) always matched. Russian puts
  // the negation first - "нет орехов" - and that shape passed untouched, which is the
  // form a guest asking about a nut allergy is actually answered in.
  const shapes = [
    "В этом блюде нет орехов.",           // negation, then term  <- used to ship
    "В этом блюде орехов нет.",           // term, then negation
    "Орехов в составе нет.",
    "Состав без орехов.",
    "Это блюдо не содержит орехов.",
    "Аллергенов нет.",
    "Бұл тағамда жаңғақ жоқ.",
    "Жаңғақ құрамында жоқ.",
    "Морепродуктов нет в этом блюде.",
    "Можно, там нет лактозы.",
    "Блюдо безглютеновое.",               // adjective, no separate negation word
    "Безопасно для аллергии на орехи.",   // reassurance, no negation at all
  ];
  for (const claim of shapes) {
    const out = validateFinalText(claim, ctx(), { toolsCalled: [] });
    assert.notEqual(out.text, claim, `an ungrounded allergen claim must never ship: ${claim}`);
    assert.ok(
      out.warnings.includes("ungrounded_allergen_assurance_removed"),
      `expected the allergen guard to fire for: ${claim}`
    );
  }
});

test("ordinary sentences that merely contain 'без' or 'нет' are left alone", () => {
  // The guard is deliberately broad, so the false-positive control is part of the fix:
  // widening it until it eats "Доставка без выходных" would be a worse bug.
  for (const innocent of [
    "Доставка без выходных.",
    "Работаем без перерыва до 23:00.",
    "Пицца без лука есть в меню?",
    "Можно оплатить без сдачи.",
    "Мы работаем безопасно и чисто.",
    "Сейчас нет свободных курьеров.",
    "Извините, этого блюда нет в наличии.",
    "Скидок нет.",
  ]) {
    const out = validateFinalText(innocent, ctx(), { toolsCalled: [] });
    assert.equal(out.text, innocent, `must not be touched: ${innocent}`);
  }
});

// ---------------------------------------------------------------------------- A29
test("only a menu read can ground an allergen answer", async () => {
  const claim = "В этом блюде нет орехов.";
  // It used to share PRICE_GROUNDING_TOOLS, so checking the order status or fetching the
  // payment requisites was accepted as proof of what is inside the food.
  for (const tool of ["checkOrderStatus", "getPaymentDetails", "getKitchenStatus", "getBusinessInfo"]) {
    const out = validateFinalText(claim, ctx(), { toolsCalled: [tool] });
    assert.notEqual(out.text, claim, `${tool} must not ground a food-composition claim`);
  }
  // And the menu read must still let the real answer through, or the guard would make
  // the bot useless to a guest with an allergy.
  const grounded = validateFinalText(claim, ctx(), { toolsCalled: ["searchMenu"] });
  assert.equal(grounded.text, claim);
  assert.equal(grounded.warnings.includes("ungrounded_allergen_assurance_removed"), false);

  const source = await read("../src/agent/finalValidator.ts");
  assert.match(source, /const ALLERGEN_GROUNDING_TOOLS = \["searchMenu"\]/);
});

// ------------------------------------------------------------------------ A31/A33
test("a read-only lookup that found nothing does not authorise an order claim", () => {
  for (const claim of [
    "Ваш заказ принят, напишите адрес доставки.",
    "Ваш заказ уже в пути, курьер выехал.",
  ]) {
    // The tool ran and came back empty. This is the exact turn the model is most
    // confident on, and it used to ship: the guest then waited for food that was never
    // entered anywhere.
    const empty = validateFinalText(claim, ctx(), {
      toolsCalled: ["checkOrderStatus"],
      toolFindings: { orderFound: false },
    });
    assert.notEqual(empty.text, claim, `a not_found lookup must not authorise: ${claim}`);

    // The tool found the order: the claim is true and must survive. checkOrderStatus can
    // find an order by a quoted number that the phone preload missed, which is why the
    // gate cannot simply require ctx.activeOrder.
    const found = validateFinalText(claim, ctx(), {
      toolsCalled: ["checkOrderStatus"],
      toolFindings: { orderFound: true },
    });
    assert.equal(found.text, claim, `a found order must survive: ${claim}`);

    // A caller that reports no findings keeps the old behaviour exactly, so this fix
    // cannot change any other call site by accident.
    const legacy = validateFinalText(claim, ctx(), { toolsCalled: ["checkOrderStatus"] });
    assert.equal(legacy.text, claim);
  }
});

test("the agent reports what checkOrderStatus returned, not just that it ran", async () => {
  const source = await read("../src/agent/fastfoodAgent.ts");
  assert.match(source, /function extractToolFindings/);
  assert.match(source, /String\(payload\.lookup \|\| ""\) === "found"/);
  // Both validation call sites must pass the findings, or the gate is dead on arrival.
  assert.equal((source.match(/toolFindings:/g) || []).length, 2);
  // "no results reported" must stay indistinguishable from the old behaviour rather
  // than silently tightening the gate for every caller. The findings now also carry
  // what escalateToAdmin returned, but an empty report still means "nothing known".
  assert.match(source, /if \(!sawLookup && escalationCreated === undefined\) return \{\};/);
});

// ---------------------------------------------------------------------------- A37
test("the critic rewrite is validated against the tools of both passes", async () => {
  const source = await read("../src/agent/fastfoodAgent.ts");
  // Validating the rewrite against its own calls alone stripped the prices and the
  // allergen statement the first pass had grounded - on exactly the high-risk turns the
  // critic exists for, because the critic note tells the model to keep the facts
  // without re-calling the tools.
  assert.match(source, /const unionCalls = mergeToolCalls\(extractToolCalls\(result\), extractToolCalls\(regenerated\)\)/);
  assert.match(source, /toolsCalled: unionCalls\.map/);
  // An order found in either pass counts as found.
  assert.match(source, /regenFindings\.orderFound === true \|\| firstFindings\.orderFound === true/);
});

// ---------------------------------------------------------------------------- A35
test("a menu snapshot authorises a price, never a promotion", () => {
  const promo = "Сегодня действует скидка 20% на всё меню.";
  // grounded = snapshotPrices || toolGrounded used to gate price AND promo together, so
  // every tenant with a preloaded menu - which is every healthy tenant - had the promo
  // guard switched off, and an invented discount reached the guest.
  const invented = validateFinalText(promo, ctx(), { toolsCalled: [] });
  assert.notEqual(invented.text, promo, "a snapshot contains no promotions");

  // When the promotion is the whole reply, warning and shipping it anyway is what let
  // the lie out. Every other guard here has a deterministic line; this one does too.
  assert.ok(invented.warnings.includes("unverified_promo_claim_replaced"));
  assert.match(invented.text, /скидк|акци/i);

  // The operator's own shift note is the live source, so it opens the gate.
  const announced = validateFinalText(promo, ctx({ activeShiftNotes: ["Сегодня скидка 20% на всё"] }), { toolsCalled: [] });
  assert.equal(announced.text, promo);

  // Notes are not always strings.
  const objectNote = validateFinalText(promo, ctx({ activeShiftNotes: [{ note: "акция: второй кофе бесплатно" }] }), { toolsCalled: [] });
  assert.equal(objectNote.text, promo);

  // A price still rides on the snapshot - that was a deliberate earlier fix and must
  // not regress.
  const price = "Пицца стоит 2500 тенге.";
  assert.equal(validateFinalText(price, ctx(), { toolsCalled: [] }).text, price);
});

// ---------------------------------------------------------------------------- A40
test("a grounded one-sentence answer is not deleted for starting with a demonstrative", () => {
  // DANGLING_REFERENCE_RE is anchored ^...$, so it matches a whole single-sentence reply
  // that merely opens with "Бұл тағам" / "Эти блюда" - and it ran unconditionally, which
  // replaced correct grounded answers with "I cannot confirm the composition". In Kazakh
  // that opener is completely ordinary.
  for (const answer of [
    "Бұл тағамда жаңғақ жоқ.",
    "Бұл тағам 2500 теңге тұрады.",
    "Бұл тағам өте дәмді, ұсынамын.",
    "Эти блюда есть в наличии.",
    "Вот варианты: пицца и паста.",
    "Осы тағам дайын.",
  ]) {
    const out = validateFinalText(answer, ctx({ language: "kk" }), { toolsCalled: ["searchMenu"] });
    assert.equal(out.text, answer, `must survive: ${answer}`);
    assert.equal(out.warnings.includes("dangling_reference_removed"), false);
  }
});

test("a pointer to a list that really was cut is still removed", () => {
  // The guard has a job: what survives a cut must not point at something that no longer
  // exists. With no snapshot and no tool the price sentence goes, and the sentence that
  // referred to it must go with it.
  const out = validateFinalText(
    "Пицца 2500 теңге. Бұл тағамдар өте дәмді.",
    ctx({ language: "kk", menuSnapshot: { items: [] } }),
    { toolsCalled: [] }
  );
  assert.ok(out.warnings.includes("ungrounded_price_claim_removed"));
  assert.ok(out.warnings.includes("dangling_reference_removed"));
  assert.doesNotMatch(out.text, /2500/);
  // And when nothing survives, the fallback must answer the question that was asked -
  // the allergen line is only honest when the allergen guard is what cut.
  assert.doesNotMatch(out.text, /құрам|состав/i);
});

// ---------------------------------------------------------------------------- A32
test("the Russian pronoun 'меня' is not a request for the menu link", () => {
  // "мен[юяью]" also matched "меня", one of the most common Russian words. "у меня
  // аллергия на орехи" minted a checkout link, pinned sendMenuLink as the forced first
  // tool and wrote a CRM lead, instead of answering the allergy question.
  for (const phrase of [
    "у меня аллергия на орехи",
    "у меня не открывается",
    "меня зовут Николай",
    "у меня вопрос по доставке",
    "спасибо, меня всё устроило",
  ]) {
    assert.equal(hasExplicitMenuLinkIntent(phrase), false, `must not be link intent: ${phrase}`);
  }
  // "меню" is indeclinable, so nothing was lost: the real requests still match.
  for (const phrase of ["меню скинь", "меню отправьте", "ссылку отправьте", "мәзір жібер", "хочу заказать"]) {
    assert.equal(hasExplicitMenuLinkIntent(phrase), true, `must stay link intent: ${phrase}`);
  }
});

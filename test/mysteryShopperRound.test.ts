import test from "node:test";
import assert from "node:assert/strict";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient } = await import("../src/services/redis.service.js");
test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const { detectLang, lastCustomerLanguage } = await import("../src/utils/language.js");
const { validateFinalText, stripReasoningPreamble } = await import("../src/agent/finalValidator.js");
const { resolveAgentToolPlan } = await import("../src/agent/toolPolicy.js");
const { detectOperatorCaseKind } = await import("../src/services/operatorCase.service.js");
const { isManualOrderCancellationClaim } = await import("../src/services/orderAuthority.service.js");
const { selectPublicMenuItems } = await import("../src/skills/searchMenu.skill.js");

// Everything here was found by playing the customer against the live agent on 2026-08-24
// (transcripts under /root/qa-lab/out). Each test names the reply the guest actually got.

function ctx(overrides: Record<string, any> = {}): any {
  return {
    instanceId: "prestige",
    phone: "77009000001",
    text: "",
    language: "kk",
    config: { domain: "https://example.kz", brand: "Crazy суши" },
    runtimeStatus: { runtime_available: true, wait_time: 0, is_emergency: false, delivery: true, pickup: true, is_accepting_orders: true, within_work_hours: true },
    hardRealtimeContext: { runtime_available: true, wait_time: 0, delivery: true, pickup: true, stale: false },
    fetchedSettings: { wait_time: 0, is_emergency: false, source: "test" },
    activeOrder: null,
    chatHistory: [],
    menuSnapshot: null,
    activeShiftNotes: [],
    shporContext: [],
    magicLink: null,
    magicLinkGranted: false,
    magicLinkAlreadySent: false,
    explicitMenuLinkIntent: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// F1: the Kazakh fallback detector called ordinary Russian words Kazakh.
// ---------------------------------------------------------------------------

test("a Russian word ending in -ия is not Kazakh", () => {
  // The boundary lookarounds around "ия|тура|мени" were written `[^\\p{L}]` inside a regex
  // LITERAL, so the class meant "not one of \ p { L }" and never held. Every one of these
  // is a word a guest types while speaking Russian, and each was classified kk.
  for (const russian of [
    "аллергия",
    "У меня аллергия на орехи, там есть орехи?",
    "Какие сейчас акции?",
    "порция большая?",
    "операция",
    "линия",
    "Россия",
    "архитектура",
    "семени",
  ]) {
    assert.equal(detectLang(russian), "ru", `${JSON.stringify(russian)} is Russian`);
  }
});

test("the Kazakh words those lookarounds protect still match", () => {
  // The fix must not cost the words the entries exist for.
  for (const kazakh of ["Ия", "ия, күтемін", "тура солай", "мени түсінші"]) {
    assert.equal(detectLang(kazakh), "kk", `${JSON.stringify(kazakh)} is Kazakh`);
  }
});

test("one Russian message no longer turns a Russian dialogue Kazakh", () => {
  // lastCustomerLanguage is built on detectLang, so the broken boundary propagated: a
  // fully Russian conversation reported kk and the next reply came back in Kazakh
  // (live QA R1-02.4: the guest wrote "Какие сейчас акции?" and was answered in Kazakh).
  const russianDialogue = [
    { role: "user", text: "Здравствуйте! Что у вас есть из роллов?" },
    { role: "assistant", text: "Калифорния 2500." },
    { role: "user", text: "У меня аллергия на орехи, там есть орехи?" },
  ];
  assert.equal(lastCustomerLanguage(russianDialogue), "ru");
});

// ---------------------------------------------------------------------------
// F2: the model narrated its reasoning to the guest.
// ---------------------------------------------------------------------------

test("a narrated reasoning preamble never reaches the guest", () => {
  // Verbatim from the live round (R1-02.4 and R4-03.3): the English narration, then the
  // real answer, in one message.
  const shipped =
    "Silent Thought: The user is asking about promotions. I should state that I don't have information about promotions.Кешіріңіз, бізде акциялар туралы ақпарат жоқ.";
  const stripped = stripReasoningPreamble(shipped);
  assert.equal(stripped.removed, true);
  assert.equal(stripped.text, "Кешіріңіз, бізде акциялар туралы ақпарат жоқ.");
  assert.doesNotMatch(stripped.text, /Silent Thought/i);

  const out = validateFinalText(shipped, ctx({ language: "kk" }));
  assert.doesNotMatch(out.text, /Silent Thought/i);
  assert.doesNotMatch(out.text, /The user is asking/i);
  assert.ok(out.warnings.includes("reasoning_preamble_removed"), JSON.stringify(out.warnings));
  assert.match(out.text, /акциялар туралы ақпарат жоқ/);
});

test("a multi-sentence narration is cut down to the answer only", () => {
  const shipped =
    "Silent Thought: The user wants the total. I have both prices in recent_dialog. I need to sum them up.«Калифорния» роллы және «Кальцоне» пиццасы екеуі 6000 теңге болады.";
  const out = validateFinalText(shipped, ctx());
  assert.match(out.text, /6000 теңге/);
  assert.doesNotMatch(out.text, /recent_dialog/);
  assert.doesNotMatch(out.text, /I need to sum/i);
});

test("an ordinary reply that merely contains the word thought is untouched", () => {
  // The guard must be anchored to a leading meta LABEL, not to a vocabulary.
  const normal = "Ойланып көріңіз, Кальцоне 3500 теңге тұрады.";
  assert.equal(stripReasoningPreamble(normal).removed, false);
  const out = validateFinalText(normal, ctx());
  assert.equal(out.text, normal);
  assert.equal(out.warnings.includes("reasoning_preamble_removed"), false);
});

// ---------------------------------------------------------------------------
// F5: a real discount the storefront advertises was deleted as "unverified".
// ---------------------------------------------------------------------------

const discountedSnapshot = {
  count: 2,
  items: [
    { name: "Калифорния", price: 2500, old_price: 3000, category: "Роллы", composition: "рис, лосось" },
    { name: "Макидзуси", price: 2500, category: "Роллы", composition: "рис" },
  ],
};

test("a promo sentence naming a genuinely discounted dish survives", () => {
  // Live QA R2b-08.1: the storefront was running four discounts and the bot answered a
  // direct "акцияларыңыз бар ма?" with a dish list and no discount at all, because the
  // promo guard cut every sentence that mentioned one.
  const reply = "Калифорния роллына жеңілдік бар: 3000 теңге орнына 2500 теңге.";
  const out = validateFinalText(reply, ctx({ menuSnapshot: discountedSnapshot }), {
    toolsCalled: ["searchMenu"],
  });
  assert.match(out.text, /Калифорния/);
  assert.match(out.text, /2500/);
  assert.ok(out.warnings.includes("promo_claim_grounded_by_menu"), JSON.stringify(out.warnings));
});

test("the framing sentence around a real discount list survives with it", () => {
  // R5-02.1 after the first fix: the dish lines were kept and the opening line
  // "Қазір мынадай акциялар бар:" was cut, so the answer began mid-thought with "Мысалы:".
  // When the reply names a real discount the topic is grounded for that reply.
  const reply = "Қазір мынадай акциялар бар. Калифорния роллы 3000 теңге орнына 2500 теңге.";
  const out = validateFinalText(reply, ctx({ menuSnapshot: discountedSnapshot }), {
    toolsCalled: ["searchMenu"],
  });
  assert.match(out.text, /мынадай акциялар бар/, out.text);
  assert.match(out.text, /2500/);
});

test("a percentage is still cut even inside a grounded promo reply", () => {
  // The catalog carries prices, never "20% off", so a percent claim can never be grounded
  // by it - not even in a reply whose other sentences are true.
  const reply = "Калифорния роллы 3000 теңге орнына 2500 теңге. Барлығына жеңілдік 20% береміз.";
  const out = validateFinalText(reply, ctx({ menuSnapshot: discountedSnapshot }), {
    toolsCalled: ["searchMenu"],
  });
  assert.match(out.text, /2500/, "the real discount survives");
  assert.doesNotMatch(out.text, /20\s*%/, "the invented percentage does not");
});

test("an invented discount on a dish that is not discounted is still cut", () => {
  // The relaxation must be per-sentence and per-dish, or it becomes a licence to invent.
  const reply = "Макидзуси роллына бүгін 50% жеңілдік береміз.";
  const out = validateFinalText(reply, ctx({ menuSnapshot: discountedSnapshot }), {
    toolsCalled: ["searchMenu"],
  });
  assert.doesNotMatch(out.text, /50%/);
  assert.ok(
    out.warnings.some((warning: string) => warning.startsWith("unverified_promo_claim")),
    JSON.stringify(out.warnings)
  );
});

test("a tenant with no discounts keeps the strict promo guard", () => {
  // Note the word order: PROMO_CLAIM_RE wants the promo word before the number, which is
  // how both languages actually phrase it ("жеңілдік 30%", "скидка 20%").
  const plainSnapshot = { count: 1, items: [{ name: "Макидзуси", price: 2500, category: "Роллы" }] };
  const out = validateFinalText("Бүгін жеңілдік 30% барлық тағамға.", ctx({ menuSnapshot: plainSnapshot }), {
    toolsCalled: ["searchMenu"],
  });
  assert.doesNotMatch(out.text, /30%/);
});

test("searchMenu reports the discount on the item itself", () => {
  // Nothing downstream can name a real promotion if the tool never returns one.
  const [item] = selectPublicMenuItems(
    [{ name: "Калифорния", price: 2500, compare_at_price: 3000, category_name: "Роллы" }],
    "калифорния"
  );
  assert.equal((item as any).old_price, 3000);
  assert.equal((item as any).discounted, true);
});

// ---------------------------------------------------------------------------
// F4: a question about the menu was answered with a bare link.
// ---------------------------------------------------------------------------

test("a menu question searches the menu before it hands over the link", () => {
  // "Не бар мәзірде?" carries the word мәзір, so hasExplicitMenuLinkIntent fires and
  // sendMenuLink was planned first - and only the FIRST planned tool is pinned as step 0.
  // The guest asked what the restaurant sells and was answered "you can see the menu at
  // this link", twice in the live round (R1-01.2, R2b-07.1).
  const plan = resolveAgentToolPlan(ctx({ text: "Не бар мәзірде?", explicitMenuLinkIntent: true }));
  assert.ok(plan.requiredTools.includes("searchMenu"), JSON.stringify(plan.requiredTools));
  assert.equal(plan.requiredTools[0], "searchMenu", `searchMenu must be pinned first: ${JSON.stringify(plan.requiredTools)}`);
  // The link is still granted on the same turn - it just stops replacing the answer.
  assert.ok(plan.requiredTools.includes("sendMenuLink"));
});

test("a guest who is placing an order still gets the link pinned", () => {
  // The swap must not touch someone who is DOING rather than asking: for them the link is
  // the answer. Two shapes that must keep their pin - naming an order action, and asking
  // for the link outright.
  for (const ordering of [
    "Екі донер заказ берейін деп едім, қазір керек",
    "Тапсырыс беремін",
    "Сілтеме жіберіңіз",
    "Хочу заказать пиццу",
  ]) {
    const plan = resolveAgentToolPlan(ctx({ text: ordering, explicitMenuLinkIntent: true }));
    assert.equal(
      plan.requiredTools[0],
      "sendMenuLink",
      `${ordering} -> ${JSON.stringify(plan.requiredTools)}`
    );
  }
});

test("a plain link request still pins the link", () => {
  const plan = resolveAgentToolPlan(ctx({ text: "Сілтеме жіберіңіз", explicitMenuLinkIntent: true }));
  assert.equal(plan.requiredTools[0], "sendMenuLink", JSON.stringify(plan.requiredTools));
});

test("a discount question is a menu lookup", () => {
  // Without this the turn reached the model with no promo facts at all.
  for (const question of ["Акцияларыңыз бар ма?", "Жеңілдік бар ма?", "Какие сейчас скидки?"]) {
    const plan = resolveAgentToolPlan(ctx({ text: question }));
    assert.ok(plan.requiredTools.includes("searchMenu"), `${question} -> ${JSON.stringify(plan.requiredTools)}`);
  }
});

// ---------------------------------------------------------------------------
// F9: "маған адам керек" was not recognised as asking for a human.
// ---------------------------------------------------------------------------

test("asking for a person in ordinary Kazakh is a human request", () => {
  // The pattern only had the comitative "адаммен". Live QA R3-04.2: the guest wrote
  // "Жоқ, маған адам керек, тез!", no case was opened, and the reply still promised that a
  // person would be told.
  for (const demand of [
    "Жоқ, маған адам керек, тез!",
    "адам керек",
    "жанды адам керек",
    "тірі адаммен сөйлескім келеді",
    "адам бар ма сонда",
    "адамды шақырыңыз",
    "мне нужен живой человек",
    "оператормен сөйлесемін",
  ]) {
    assert.equal(detectOperatorCaseKind(demand), "human_request", JSON.stringify(demand));
  }
});

test("ordinary sentences containing the word person are not escalations", () => {
  // The noun is common; only a request next to it counts.
  for (const innocent of ["Бір адамға жетеді ме?", "Екі адамға сет бар ма?", "адамдар көп"]) {
    assert.notEqual(detectOperatorCaseKind(innocent), "human_request", JSON.stringify(innocent));
  }
});

// ---------------------------------------------------------------------------
// F10: the bot said it had cancelled the order.
// ---------------------------------------------------------------------------

test("the bot never claims to have cancelled an order", () => {
  // Live QA R3-05.1: "Ойымды өзгерттім, тапсырысты болдырмаңыз" was answered "Жарайды,
  // тапсырысыңызды тоқтатамыз" - the guest stopped waiting for a cancellation nobody had
  // been asked to perform.
  const claim = "Жарайды, тапсырысыңызды тоқтатамыз. Тағы не көмектесе аламын?";
  assert.equal(isManualOrderCancellationClaim(claim), true);
  const out = validateFinalText(claim, ctx(), { toolsCalled: [] });
  assert.ok(out.warnings.includes("manual_cancellation_claim_blocked"), JSON.stringify(out.warnings));
  assert.match(out.text, /оператор/i);
  assert.doesNotMatch(out.text, /тоқтатамыз/);

  for (const russian of ["Хорошо, заказ отменил.", "Мы отменим ваш заказ."]) {
    assert.equal(isManualOrderCancellationClaim(russian), true, russian);
  }
});

test("the honest cancellation handoff wording is not blocked", () => {
  // The deterministic cancel lane says a person will do it. That must survive.
  const honest = "Тапсырысты болдырмау өтінішіңізді операторға жеткіздім, ол сізбен байланысады.";
  assert.equal(isManualOrderCancellationClaim(honest), false);
  const out = validateFinalText(honest, ctx(), { toolsCalled: [] });
  assert.equal(out.warnings.includes("manual_cancellation_claim_blocked"), false);
});

// ---------------------------------------------------------------------------
// F11: the bot invented a delivery zone out of the restaurant's own address.
// ---------------------------------------------------------------------------

test("the bot never refuses delivery to an address", () => {
  // Live QA R3-06.1 and again R5-07.1: the guest gave their street and was told
  // "Өкінішке орай, біз тек Арман 54 мекенжайына жеткіземіз" - Арман 54 is where the
  // KITCHEN is. Nothing in this agent knows the delivery zone; the site decides it at
  // checkout, so the sale died on a boundary that does not exist.
  const invented = "Өкінішке орай, біз тек Арман 54 мекенжайына жеткіземіз.";
  const out = validateFinalText(invented, ctx(), { toolsCalled: ["getBusinessInfo"] });
  assert.ok(out.warnings.includes("invented_delivery_zone_removed"), JSON.stringify(out.warnings));
  assert.doesNotMatch(out.text, /тек Арман 54/);
  // The replacement has to point at the one thing that CAN answer the question.
  assert.match(out.text, /сайт/i);
});

test("a zone refusal is cut clause by clause, keeping the rest of the answer", () => {
  const mixed = "Донер 1000 теңге тұрады. Абай 10 мекенжайына жеткізу мүмкін емес.";
  const out = validateFinalText(mixed, ctx({ menuSnapshot: discountedSnapshot }), {
    toolsCalled: ["searchMenu"],
  });
  assert.match(out.text, /1000 теңге/, "the real price survives");
  assert.doesNotMatch(out.text, /жеткізу мүмкін емес/);
});

test("an operational delivery outage is still sayable", () => {
  // The kitchen switching delivery off is a real fact the runtime reports, and the
  // deterministic channel reply says exactly this. It must not be mistaken for an
  // invented zone boundary.
  const real = "Жеткізу қызметі қазір қолжетімді емес, тек алып кетуге болады.";
  const out = validateFinalText(real, ctx(), { toolsCalled: ["getKitchenStatus"] });
  assert.equal(out.warnings.includes("invented_delivery_zone_removed"), false, JSON.stringify(out.warnings));
  assert.match(out.text, /алып кетуге/);
});

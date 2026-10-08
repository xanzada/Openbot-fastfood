import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLegacyNewOrderMessage,
  buildLegacyRejectedMessage,
  formatLegacyPaymentMessage,
  legacyStatusTemplates,
  orderNotifyRank,
  parsePickupFlag,
  resolveStatusCustomerMessage,
} from "../src/controllers/kanban.js";

test("new_order message preserves Kazakh UTF-8 and order details", () => {
  const text = buildLegacyNewOrderMessage({
    total_price: 6600,
    comment: "[Списано 400Б] | Приборы: 2 шт",
    items: [{ name: "Кальцоне", qty: 2, price: 3500 }],
  }, "kk", "35", true);

  assert.equal(text, [
    "🛍 *№35 тапсырысыңыз қабылданды!*",
    "🏃 *Түрі:* Алып кету (Самовывоз)",
    "🎁 *Жұмсалған бонус:* 400 ₸",
    "🍴 *Адам саны:* 2",
    "",
    "🛒 *Тапсырыс құрамы:*",
    "▪️ Кальцоне x2 = 7000 ₸",
    "➖➖➖➖➖➖➖",
    "💰 *БАРЛЫҒЫ: 6600 ₸*",
    "➖➖➖➖➖➖➖",
    "",
    "⏳ *Назарыңызға:* Біз ас үйде бар-жоғын тексеріп жатырмыз, 1-2 минут күте тұрыңыз...",
  ].join("\n"));
  assert.doesNotMatch(text, /(?:Рџ|РЎ|вЏ|вњ|РµР)/);
});

test("payment, rejection and lifecycle templates remain valid UTF-8", () => {
  assert.equal(formatLegacyPaymentMessage("6600", "Kaspi: +77764846565\nHalyk: +77745456456", "kk"), [
    "✅ *Бәрі бар!*",
    "💰 Төлем сомасы: *6600 ₸*",
    "",
    "💳 *Төлем жасау:*",
    "Kaspi: +77764846565",
    "Halyk: +77745456456",
    "",
    "🧾 *Төлем жасағаннан кейін чекті осы чатқа жіберіңіз 👇*",
  ].join("\n"));
  assert.equal(legacyStatusTemplates.kk.paid, "✅ Төлем расталды, тапсырысыңыз қабылданды. Дайындалуда! 🍳");
  assert.equal(legacyStatusTemplates.kk.delivery, "✅ Тапсырысыңыз дайын және курьерге берілді. Қазір сізге қарай жолда 🛵");
  assert.equal(legacyStatusTemplates.kk.completed, "🎉 Тапсырыс сәтті аяқталды, асыңыз дәмді болсын!");
  assert.match(buildLegacyRejectedMessage({ reason: "Тағам жоқ" }, "kk"), /Тағам жоқ/);
});

test("delivery handoff sends one combined bilingual update instead of ready plus courier duplicates", () => {
  // Delivery orders must stay silent at the intermediate kitchen-ready step.
  // The courier handoff then communicates both facts in one human message.
  assert.equal(resolveStatusCustomerMessage("ready", false, "kk"), "");
  assert.equal(
    resolveStatusCustomerMessage("delivery", false, "kk"),
    "✅ Тапсырысыңыз дайын және курьерге берілді. Қазір сізге қарай жолда 🛵",
  );
  assert.equal(resolveStatusCustomerMessage("ready", false, "ru"), "");
  assert.equal(
    resolveStatusCustomerMessage("delivery", false, "ru"),
    "✅ Ваш заказ готов и передан курьеру. Он уже едет к вам 🛵",
  );

  // Pickup has no courier transition, so its useful ready notification remains.
  assert.equal(resolveStatusCustomerMessage("ready", true, "kk"), "✅ Тапсырысыңыз дайын! Келіп алып кетуіңізге болады.");
  assert.equal(resolveStatusCustomerMessage("ready", true, "ru"), "✅ Ваш заказ готов! Можете забирать.");
});

test("delivery order shows localized fee below the comment and removes the raw marker", () => {
  const free = buildLegacyNewOrderMessage({
    total_price: 8200,
    address: "Брусиловского 18",
    comment: "[Доставка 0т] Тегін не бар",
    items: [{ name: "Пицца", qty: 1, price: 8200 }],
  }, "kk", "37", false);
  assert.match(free, /💬 \*Пікір:\* Тегін не бар\n🚚 \*Жеткізу:\* Тегін/);
  assert.doesNotMatch(free, /\[Доставка/);

  const paid = buildLegacyNewOrderMessage({
    total_price: 8800,
    delivery_fee: 600,
    comment: "Позвонить заранее",
    items: [{ name: "Пицца", qty: 1, price: 8200 }],
  }, "ru", "38", false);
  assert.match(paid, /💬 \*Комментарий:\* Позвонить заранее\n🚚 \*Доставка:\* 600 ₸/);
});

// The site sends the real delivery fee when it charges one and an explicit free
// marker above the threshold; with no field at all the bot must not invent
// "Тегін" (live, 2026-08-14).
test("the delivery line shows the site's real fee, says free only on an explicit marker, and never invents free", () => {
  const feeMsg = buildLegacyNewOrderMessage({ total_price: 5200, delivery_price: 500, items: [{ name: "Pizza", qty: 1, price: 5200 }] }, "kk", "1", false);
  assert.match(feeMsg, /Жеткізу:\* 500 ₸/u);

  const freeMsg = buildLegacyNewOrderMessage({ total_price: 9000, delivery_price: 0, items: [{ name: "Pizza", qty: 1, price: 9000 }] }, "kk", "1", false);
  assert.match(freeMsg, /Жеткізу:\* Тегін/u);

  const freeWordMsg = buildLegacyNewOrderMessage({ total_price: 9000, delivery_price: "тегін", items: [{ name: "Pizza", qty: 1, price: 9000 }] }, "kk", "1", false);
  assert.match(freeWordMsg, /Жеткізу:\* Тегін/u);

  const unknownMsg = buildLegacyNewOrderMessage({ total_price: 5200, items: [{ name: "Pizza", qty: 1, price: 5200 }] }, "kk", "1", false);
  assert.match(unknownMsg, /Жеткізу:\* сайтта есептеледі/u);
  assert.doesNotMatch(unknownMsg, /Жеткізу:\* Тегін/u);
});

test("a stale replay never moves the guest backwards and a cancel blocks late payment asks", () => {
  assert.ok(orderNotifyRank("status_changed", "ready_delivery") < orderNotifyRank("status_changed", "delivery"));
  assert.ok(orderNotifyRank("request_payment") < orderNotifyRank("order_rejected"));
  assert.ok(orderNotifyRank("new_order") < orderNotifyRank("status_changed", "paid"));
  assert.equal(orderNotifyRank("status_changed", "pickup_ready"), orderNotifyRank("status_changed", "ready_delivery"));
  assert.equal(orderNotifyRank("status_changed", "mystery_status"), -1);
});

test("pickup order shows no address and no delivery line; the delivery fee is exact", () => {
  const pickup = buildLegacyNewOrderMessage({ total_price: 5000, delivery_price: 0, items: [{ name: "Ролл", qty: 1, price: 5000 }] }, "kk", "40", true);
  assert.match(pickup, /Алып кету/);
  assert.doesNotMatch(pickup, /Мекенжай/);
  assert.doesNotMatch(pickup, /Жеткізу/);

  const free = buildLegacyNewOrderMessage({ total_price: 9000, address: "Абая 10", delivery_price: 0, items: [{ name: "Ролл", qty: 1, price: 9000 }] }, "kk", "41", false);
  assert.match(free, /🚚 \*Жеткізу:\* Тегін/);

  const paid = buildLegacyNewOrderMessage({ total_price: 7000, address: "Абая 10", delivery_price: 1000, items: [{ name: "Ролл", qty: 1, price: 6000 }] }, "kk", "42", false);
  assert.match(paid, /🚚 \*Жеткізу:\* 1000 ₸/);
});

test("fulfillment_type words map to the pickup flag and the cancel note offers the menu", () => {
  assert.equal(parsePickupFlag("pickup"), true);
  assert.equal(parsePickupFlag("delivery"), false);
  assert.equal(parsePickupFlag("самовывоз"), true);
  assert.equal(parsePickupFlag(true), true);
  assert.equal(parsePickupFlag(false), false);
  assert.equal(parsePickupFlag(undefined), false);
  assert.match(buildLegacyRejectedMessage({ reason: "Тағам бітіп қалды" }, "kk"), /[Мм]әзір/);
  assert.match(buildLegacyRejectedMessage({ reason: "Тағам бітіп қалды" }, "kk"), /Тағам бітіп қалды/);
  assert.match(buildLegacyRejectedMessage({}, "ru"), /меню/);
});

test("a spent bonus shows as its own line in the order message", () => {
  const msg = buildLegacyNewOrderMessage({ total_price: 6500, delivery_price: 1000, bonus: 500, address: "Абая 10", items: [{ name: "Ролл", qty: 2, price: 3000 }] }, "kk", "22", false);
  assert.match(msg, /🎁 \*Жұмсалған бонус:\* 500 ₸/);
  assert.match(msg, /БАРЛЫҒЫ: 6500 ₸/);
});


// Payment-requisites controls use the actual exported helper and actual handler.
// All external requests are intercepted; Redis is the private test fixture only.
const paymentRequisitesIntegration = { skip: process.env.AUDIT_REDIS_INTEGRATION !== "1", timeout: 15_000 };
const paymentRequisitesCases = ["empty_top", "empty_nested", "malformed", "null", "throw", "mirror", "top", "nested"] as const;
type PaymentRequisitesCase = typeof paymentRequisitesCases[number];
const paymentRequisitesExpected = {
  ru: "Реквизиты для оплаты сейчас недоступны. Перед оплатой уточните их у ресторана.",
  kk: "Төлем реквизиттері қазір қолжетімді емес. Төлем жасамас бұрын оларды рестораннан сұрап алыңыз.",
};

async function withPaymentRequisitesFixture(
  caseName: PaymentRequisitesCase,
  language: "ru" | "kk",
  run: (fixture: {
    instance: string; phone: string; config: Record<string, unknown>;
    runtimeReads: () => number; orderReads: () => number;
    delivered: Array<{ text: string; requestId: string }>;
    expectedDetails: string | null;
  }) => Promise<void>,
) {
  const crypto = await import("node:crypto");
  const axios = (await import("axios")).default;
  const { redisClient, connectRedis, saveKitchenStatus } = await import("../src/services/redis.service.js");
  await connectRedis();
  const instance = `audit-requisites-${crypto.randomBytes(5).toString("hex")}`;
  const phone = "77000000001";
  const config = {
    instance_id: instance, whatspro_base_url: "https://synthetic.invalid", whatspro_api_token: "synthetic-test-only",
    alemi_api_url: "https://synthetic.invalid", alemi_secret: "synthetic-test-only",
  };
  await redisClient.set(`config:${instance}`, JSON.stringify(config), { EX: 120 });
  const details = [{ label: "Synthetic bank", value: "SYNTHETIC-ACCOUNT-ONLY" }];
  const expectedDetails = ["mirror", "top", "nested"].includes(caseName) ? "Synthetic bank: SYNTHETIC-ACCOUNT-ONLY" : null;
  if (caseName === "mirror") await saveKitchenStatus(instance, { payment_details: details });
  // A stale cached value must not win the actual forceFresh runtime fallback.
  if (!["mirror", "null", "throw"].includes(caseName)) {
    await redisClient.set(`runtime_status:${instance}`, JSON.stringify({ payment_details: [{ label: "STALE", value: "MUST-NOT-BE-USED" }] }), { EX: 120 });
  }
  let runtimeReads = 0; let orderReads = 0;
  const delivered: Array<{ text: string; requestId: string }> = [];
  const originalGet = axios.get; const originalPost = axios.post;
  axios.get = (async () => { throw new Error("SYNTHETIC_NETWORK_DENIED"); }) as any;
  axios.post = (async (url: string, input: any) => {
    if (url === "https://synthetic.invalid/api/send") {
      assert.equal(input.instanceId, instance); assert.equal(input.phone, phone);
      assert.equal(typeof input.text, "string"); assert.match(input.requestId, /^[a-f0-9]{64}$/);
      delivered.push({ text: input.text, requestId: input.requestId });
      return { status: 200, data: { success: true, messageId: "SYNTHETIC-PAYMENT-ACK" } };
    }
    assert.equal(url, "https://synthetic.invalid/v1/integrations/bot/commands", "no unregistered HTTP route is permitted");
    const command = typeof input === "string" ? JSON.parse(input) : input;
    assert.equal(command.instance, instance);
    if (command.command === "order.context.get") {
      orderReads++;
      return { status: 200, data: { result: { order: {
        id: "142", phone, status: "pending", payment_timing: "prepay", payment_revision: 1, receipt_required: true, total_price: 2000,
      } } } };
    }
    assert.equal(command.command, "runtime.status.get"); runtimeReads++;
    assert.notEqual(caseName, "mirror", "populated kitchen mirror bypasses the live runtime read");
    if (caseName === "throw") throw new Error("SYNTHETIC_RUNTIME_UNAVAILABLE");
    const runtime: unknown = caseName === "null" ? null
      : caseName === "top" ? { payment_details: details }
      : caseName === "nested" ? { payment_details: [], kitchen_status: { payment_details: details } }
      : caseName === "empty_nested" ? { payment_details: [], kitchen_status: { payment_details: [] } }
      : caseName === "malformed" ? { payment_details: [null, 17, {}, { label: "Empty", value: "  " }], kitchen_status: { payment_details: "not-an-array" } }
      : { payment_details: [] };
    return { status: 200, data: { result: runtime } };
  }) as any;
  try {
    await run({ instance, phone, config, runtimeReads: () => runtimeReads, orderReads: () => orderReads, delivered, expectedDetails });
  } finally {
    axios.get = originalGet; axios.post = originalPost;
    // Every key belongs to this generated instance in the private Redis only.
    const keys = new Set<string>();
    for (const pattern of [`${instance}:*`, `*:${instance}`, `*:${instance}:*`]) {
      for (const key of await redisClient.keys(pattern)) {
        assert.ok(key.startsWith(`${instance}:`) || key.endsWith(`:${instance}`) || key.includes(`:${instance}:`));
        keys.add(key);
      }
    }
    if (keys.size) await redisClient.del([...keys]);
  }
}

function assertHonestPaymentRequisites(text: string, language: "ru" | "kk", expectedDetails: string | null) {
  if (expectedDetails) {
    assert.ok(text.includes(expectedDetails), "only the genuinely configured requisites are returned/delivered");
    assert.ok(!text.includes(paymentRequisitesExpected[language]));
  } else {
    assert.ok(text.includes(paymentRequisitesExpected[language]), "empty data names uncertainty and asks the guest to obtain requisites before paying");
  }
  assert.doesNotMatch(text, /уточняются|свяжется|всё подтвердит|нақтылануда|байланысып|растайды|MUST-NOT-BE-USED/u);
}

for (const language of ["ru", "kk"] as const) {
  for (const caseName of paymentRequisitesCases) {
    test(`payment requisites honest: helper ${language} ${caseName}`, paymentRequisitesIntegration, async () => {
      await withPaymentRequisitesFixture(caseName, language, async f => {
        const { getPaymentRequisitesText } = await import("../src/controllers/kanban.js");
        const text = await getPaymentRequisitesText(f.instance, f.config, language);
        assertHonestPaymentRequisites(text, language, f.expectedDetails);
        if (f.expectedDetails) assert.equal(text, f.expectedDetails);
        else assert.equal(text, paymentRequisitesExpected[language]);
        assert.equal(f.runtimeReads(), caseName === "mirror" ? 0 : 1);
        assert.equal(f.orderReads(), 0); assert.equal(f.delivered.length, 0);
      });
    });
    test(`payment requisites honest: handler ${language} ${caseName}`, paymentRequisitesIntegration, async () => {
      await withPaymentRequisitesFixture(caseName, language, async f => {
        const crypto = await import("node:crypto");
        const { handleKanbanWebhook } = await import("../src/controllers/kanban.js");
        const { redisClient } = await import("../src/services/redis.service.js");
        const body = { instance: f.instance, action: "request_payment", order_id: "142", event_id: crypto.randomUUID(), phone: f.phone, lang: language, total_price: 2000, payment_timing: "prepay", payment_revision: 1, receipt_required: true };
        const invoke = async () => {
          let status = 200; let response: any;
          const res: any = { headersSent: false, status(code: number) { status = code; return this; }, json(value: unknown) { response = value; this.headersSent = true; return this; } };
          await handleKanbanWebhook({ body: { ...body }, app: { get: () => null } } as any, res);
          assert.equal(status, 200); assert.equal(response?.success, true); assert.notEqual(response?.retry_later, true);
        };
        await invoke();
        assert.equal(f.orderReads(), 1, "permission uses the actual fresh order context");
        assert.equal(f.runtimeReads(), caseName === "mirror" ? 0 : 1);
        assert.equal(f.delivered.length, 1);
        const sent = f.delivered[0];
        assertHonestPaymentRequisites(sent.text, language, f.expectedDetails);
        const paymentInfo = f.expectedDetails || paymentRequisitesExpected[language];
        assert.equal(sent.text, formatLegacyPaymentMessage("2000", paymentInfo, language));
        const journal = JSON.parse((await redisClient.get(`kanban_lock:${f.instance}:142:request_payment`))!);
        assert.equal(journal.phase, "complete"); assert.equal(journal.payload.text, sent.text); assert.equal(journal.payload.requestId, sent.requestId);
        const history = await redisClient.lRange(`history:${f.instance}:${f.phone}`, 0, -1);
        assert.equal(history.length, 1); assert.ok(JSON.parse(history[0]).text.includes(sent.text));
        await invoke();
        assert.equal(f.delivered.length, 1, "completed replay produces no second customer message");
        assert.equal((await redisClient.lRange(`history:${f.instance}:${f.phone}`, 0, -1)).length, 1);
      });
    });
  }
}

test.after(async () => {
  if (process.env.AUDIT_REDIS_INTEGRATION === "1") {
    const { redisClient } = await import("../src/services/redis.service.js");
    if (redisClient.isOpen) await redisClient.quit();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOnReceiptAcceptedMessage,
  buildPaymentTimingChangedMessage,
  buildReceiptNotNeededReply,
  buildStaleReceiptReply,
  currentPaymentView,
  decidePaymentRequest,
  decideTimingChangeNotice,
  paymentFieldsFrom,
} from "../src/services/paymentTiming.service.js";
import { orderDocumentCanonical, reportAnalyzedReceipt, uploadOrderDocument, type AlemiTransportRequest } from "../src/services/alemiApi.service.js";
import { deliverReceiptToClient } from "../src/services/receiptDelivery.service.js";
import { customerOrderFromRecord, orderNextStepLine } from "../src/services/customerOrder.service.js";
import { normalizeOrderPayload } from "../src/services/dle.service.js";
import { normalizeDlePayload } from "../src/routes/dleWebhook.route.js";

const CONFIG = { instance_id: "tenant-a", alemi_instance: "tenant-a", alemi_secret: "tenant-a-secret" };

test("payment fields: legacy null stays legacy, timing without revision is revision 1", () => {
  assert.deepEqual(paymentFieldsFrom({}), { timing: null, revision: null, receiptRequired: null });
  assert.deepEqual(paymentFieldsFrom({ payment_timing: null, payment_revision: null }), { timing: null, revision: null, receiptRequired: null });
  assert.deepEqual(paymentFieldsFrom({ payment_timing: "on_receipt", payment_revision: 2, receipt_required: false }), { timing: "on_receipt", revision: 2, receiptRequired: false });
  assert.deepEqual(paymentFieldsFrom({ payment_timing: "prepay", receipt_required: "true" }), { timing: "prepay", revision: 1, receiptRequired: true });
  assert.equal(paymentFieldsFrom({ payment_timing: "bogus", payment_revision: "x" }).revision, null);
});

test("the newest revision wins; a fresh read wins a tie", () => {
  const view = currentPaymentView(
    { timing: "prepay", revision: 2, receiptRequired: true },
    { timing: "on_receipt", revision: 3, receiptRequired: false },
    null,
  );
  assert.deepEqual(view, { timing: "on_receipt", revision: 3, receiptRequired: false });
  const tie = currentPaymentView(
    { timing: "prepay", revision: 3, receiptRequired: true },
    null,
    { timing: "on_receipt", revision: 3, receiptRequired: false },
  );
  assert.equal(tie.timing, "on_receipt");
});

test("receipt request for an on_receipt order finishes without a message", () => {
  const decision = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: null,
    fresh: { status: "pending", fields: { timing: "on_receipt", revision: 2, receiptRequired: false } },
  });
  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "stale_payment_revision");
  const sameRevision = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "on_receipt", revision: 2, receiptRequired: false },
    stored: null,
    fresh: null,
  });
  assert.deepEqual([sameRevision.action, sameRevision.reason], ["skip", "on_receipt_no_receipt"]);
});

test("operator confirm of an on_receipt order tells the sum and pay-on-receipt, never requisites", () => {
  const decision = decidePaymentRequest({
    isReceiptRequest: false,
    event: { timing: "on_receipt", revision: 1, receiptRequired: false },
    stored: null,
    fresh: { status: "confirmed", fields: { timing: "on_receipt", revision: 1, receiptRequired: false } },
  });
  assert.equal(decision.action, "send_on_receipt_accept");
  for (const lang of ["ru", "kk"] as const) {
    const text = buildOnReceiptAcceptedMessage(6500, lang);
    assert.match(text, /6500 ₸/);
    assert.doesNotMatch(text, /реквизит|Kaspi|отправьте чек|чекті .*жіберіңіз/i);
  }
  assert.match(buildOnReceiptAcceptedMessage(6500, "ru"), /Оплата при получении/);
});

test("prepay keeps the classic flow, legacy orders too", () => {
  const prepay = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: { timing: "prepay", revision: 1, receiptRequired: true },
    fresh: { status: "pending", fields: { timing: "prepay", revision: 1, receiptRequired: true } },
  });
  assert.equal(prepay.action, "send_requisites");
  const legacy = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: null, revision: null, receiptRequired: true },
    stored: null,
    fresh: { status: "pending", fields: { timing: null, revision: null, receiptRequired: true } },
  });
  assert.deepEqual([legacy.action, legacy.reason], ["send_requisites", "legacy_prepay"]);
});

test("late receipt request after cooking started, or with receipt_required=false, is skipped", () => {
  const cooking = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: null,
    fresh: { status: "preparing", fields: { timing: "prepay", revision: 1, receiptRequired: true } },
  });
  assert.equal(cooking.reason, "order_not_pending");
  const notRequired = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: null,
    fresh: { status: "pending", fields: { timing: "prepay", revision: 1, receiptRequired: false } },
  });
  assert.equal(notRequired.reason, "receipt_not_required");
});

test("timing change: revision 3 before 2 -> only 3 speaks; finished orders stay silent", () => {
  const rev3 = decideTimingChangeNotice({
    event: { timing: "prepay", revision: 3, receiptRequired: true },
    stored: { timing: "on_receipt", revision: 1, receiptRequired: false },
    fresh: { status: "pending", fields: { timing: "prepay", revision: 3, receiptRequired: true } },
  });
  assert.deepEqual([rev3.action, rev3.view.timing], ["notify", "prepay"]);
  const rev2Late = decideTimingChangeNotice({
    event: { timing: "on_receipt", revision: 2, receiptRequired: false },
    stored: { timing: "prepay", revision: 3, receiptRequired: true },
    fresh: null,
  });
  assert.deepEqual([rev2Late.action, rev2Late.reason], ["skip", "stale_payment_revision"]);
  const cancelled = decideTimingChangeNotice({
    event: { timing: "on_receipt", revision: 2, receiptRequired: false },
    stored: null,
    fresh: { status: "cancelled", fields: { timing: "on_receipt", revision: 2, receiptRequired: false } },
  });
  assert.equal(cancelled.reason, "order_inactive");
});

test("timing change texts state the current choice once, with the saved sum", () => {
  const toOnReceipt = buildPaymentTimingChangedMessage("on_receipt", { orderNumber: "88", total: 7000 }, "ru");
  assert.match(toOnReceipt, /оплата при получении/);
  assert.match(toOnReceipt, /№88/);
  assert.match(toOnReceipt, /7000 ₸/);
  assert.match(toOnReceipt, /чек отправлять не нужно/);
  const toPrepay = buildPaymentTimingChangedMessage("prepay", { orderNumber: "88", total: 7000 }, "kk");
  assert.match(toPrepay, /алдын ала төлеу/);
  assert.doesNotMatch(buildPaymentTimingChangedMessage("prepay", { orderNumber: "", total: null }, "ru"), /Сумма|№/);
  assert.match(buildReceiptNotNeededReply("ru", "12"), /№12 оплачивается при получении/);
  assert.match(buildStaleReceiptReply("ru", "prepay"), /Условия оплаты по заказу изменились/);
  assert.match(buildStaleReceiptReply("kk", "on_receipt"), /алған кезде төленеді/);
});

test("analyzed receipt carries the captured payment_revision", async () => {
  let captured: AlemiTransportRequest | null = null;
  await reportAnalyzedReceipt({
    instanceId: "tenant-a",
    orderId: "order-42",
    sourceMessageId: "wa-1",
    amount: 8000,
    text: "Customer B. сумма 8000 ₸ Kaspi",
    paymentRevision: 3,
  }, {
    config: CONFIG,
    commandId: "cmd-rev",
    transport: async (request) => {
      captured = request;
      return { status: 201, data: { result: { accepted: true } } };
    },
  });
  const body = JSON.parse(String((captured as any)?.body || ""));
  assert.deepEqual(Object.keys(body.data).sort(), ["order_id", "payment_revision", "source_message_id", "text"]);
  assert.equal(body.data.payment_revision, 3);
});

test("file descriptor: revision 1 keeps the historical format, later revisions append a last line + header", async () => {
  const base = { commandId: "c", instance: "i", orderId: "o", sourceMessageId: "m", kind: "receipt", mimeType: "image/png", contentSha256: "h" };
  assert.equal(orderDocumentCanonical(base), "order-document-upload-v1\nc\ni\no\nm\nreceipt\nimage/png\nh");
  assert.equal(orderDocumentCanonical({ ...base, paymentRevision: 1 }), orderDocumentCanonical(base));
  assert.equal(orderDocumentCanonical({ ...base, paymentRevision: 2 }), `${orderDocumentCanonical(base)}\n2`);

  const headersSeen: Array<Record<string, string>> = [];
  for (const paymentRevision of [1, 4]) {
    await uploadOrderDocument({
      instanceId: "tenant-a",
      orderId: "order-42",
      sourceMessageId: "wa-2",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "image/png",
      paymentRevision,
    }, {
      config: CONFIG,
      commandId: "cmd-up",
      transport: async (request) => {
        headersSeen.push(request.headers);
        return { status: 201, data: { order_id: "order-42" } };
      },
    });
  }
  assert.equal(headersSeen[0]["X-Payment-Revision"], undefined);
  assert.equal(headersSeen[1]["X-Payment-Revision"], "4");
});

test("409 on the analyzed receipt is final: no fallback upload, a dedicated failure code", async () => {
  let uploads = 0;
  const result = await deliverReceiptToClient({
    instanceId: "tenant-a",
    phone: "77001234567",
    orderNumber: "order-42",
    config: CONFIG,
    amount: 8000,
    senderName: "B",
    bankName: "Kaspi",
    receiptBase64: Buffer.from([1, 2, 3]).toString("base64"),
    mimeType: "image/png",
    sourceMessageId: "wa-3",
    paymentRevision: 1,
  }, {
    sendAnalysis: async () => {
      throw Object.assign(new Error("ALEMI_HTTP_409"), { statusCode: 409 });
    },
    sendDocument: async () => {
      uploads += 1;
      return { order_id: "order-42" };
    },
  });
  assert.equal(result.success, false);
  assert.equal((result as any).errorCode, "payment_revision_conflict");
  assert.equal(uploads, 0);
});

test("customer-facing status of an on_receipt order never asks for a receipt", () => {
  const confirmed = customerOrderFromRecord({ order: { id: "o1", display_number: "88", status: "confirmed", payment_timing: "on_receipt", payment_revision: 2 } }, "", "ru");
  assert.equal(confirmed.state, "found");
  if (confirmed.state !== "found") return;
  assert.equal(confirmed.order.stage, "preparing");
  assert.match(confirmed.order.statusExplanation, /оплата при получении/);
  const pending = customerOrderFromRecord({ order: { id: "o1", display_number: "88", status: "pending", payment_timing: "on_receipt" } }, "", "ru");
  if (pending.state !== "found") throw new Error("not found");
  assert.equal(pending.order.stage, "awaiting_confirmation");
  assert.doesNotMatch(`${pending.order.statusExplanation} ${orderNextStepLine(pending.order, "ru")}`, /после оплаты|после чека|Пришлите чек/);
  const legacy = customerOrderFromRecord({ order: { id: "o2", status: "confirmed" } }, "", "ru");
  if (legacy.state !== "found") throw new Error("not found");
  assert.equal(legacy.order.stage, "awaiting_receipt");
});

test("order.payment_timing_changed is its own action with the payment fields", () => {
  const req: any = {
    body: {
      schema_version: 1,
      event_id: "evt_1",
      event_type: "order.payment_timing_changed",
      instance: "restaurant_instance",
      data: {
        order_id: "550e8400-e29b-41d4-a716-446655440000",
        order_number: 88,
        previous_payment_timing: "prepay",
        payment_timing: "on_receipt",
        payment_revision: 2,
        receipt_required: false,
      },
    },
    query: {},
    headers: {},
  };
  normalizeDlePayload(req);
  assert.equal(req.body.action, "payment_timing_changed");
  assert.equal(req.body.payment_timing, "on_receipt");
  assert.equal(req.body.payment_revision, 2);
  assert.equal(req.body.receipt_required, false);
  assert.equal(req.body.previous_payment_timing, "prepay");
  assert.deepEqual(paymentFieldsFrom(req.body), { timing: "on_receipt", revision: 2, receiptRequired: false });
});

test("issue 1: normalizeOrderPayload preserves total_amount_minor as full tenge without dividing by 100", () => {
  const onlineOrder = normalizeOrderPayload({
    id: "order-101",
    total_amount_minor: 7000,
    items: [{ name: "Burger", qty: 2, price: 3500 }],
  });
  assert.equal(onlineOrder.total_price, 7000);

  const subtotalOrder = normalizeOrderPayload({
    id: "order-102",
    subtotal_amount_minor: 5500,
  });
  assert.equal(subtotalOrder.total_price, 5500);

  const classicOrder = normalizeOrderPayload({
    id: "order-103",
    total_price: 4200,
    total_amount_minor: 4200,
  });
  assert.equal(classicOrder.total_price, 4200);
});

test("issue 2: receipt request requires fresh pending order; unavailable retries, expired/inactive skip", () => {
  // fresh == null -> retry_later, fresh_order_unavailable
  const unavailable = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: null,
    fresh: null,
  });
  assert.deepEqual([unavailable.action, unavailable.reason], ["retry_later", "fresh_order_unavailable"]);

  // fresh.status === 'expired' -> skip, order_expired
  const expired = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: null,
    fresh: { status: "expired", fields: { timing: "prepay", revision: 1, receiptRequired: true } },
  });
  assert.deepEqual([expired.action, expired.reason], ["skip", "order_expired"]);

  // fresh.status inactive -> skip, order_inactive
  const completed = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: null,
    fresh: { status: "completed", fields: { timing: "prepay", revision: 1, receiptRequired: true } },
  });
  assert.deepEqual([completed.action, completed.reason], ["skip", "order_inactive"]);

  // fresh.status unknown or progressed -> skip, order_not_pending
  const unknownStatus = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: null,
    fresh: { status: "awaiting_something_new", fields: { timing: "prepay", revision: 1, receiptRequired: true } },
  });
  assert.deepEqual([unknownStatus.action, unknownStatus.reason], ["skip", "order_not_pending"]);

  // receiptRequired !== true -> skip, receipt_not_required
  const notRequiredNull = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: null },
    stored: null,
    fresh: { status: "pending", fields: { timing: "prepay", revision: 1, receiptRequired: null } },
  });
  assert.deepEqual([notRequiredNull.action, notRequiredNull.reason], ["skip", "receipt_not_required"]);
});

test("issue 3: receipt request without revision defaults to revision 1 and skips if stale", () => {
  // Stored state is at revision 3 (switched prepay -> on_receipt -> prepay)
  // Incoming request has no revision field (event.revision == null) -> defaults to 1
  const staleNoRevision = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: null, receiptRequired: true },
    stored: { timing: "prepay", revision: 3, receiptRequired: true },
    fresh: { status: "pending", fields: { timing: "prepay", revision: 3, receiptRequired: true } },
  });
  assert.equal(staleNoRevision.action, "skip");
  assert.equal(staleNoRevision.reason, "stale_payment_revision");

  // Incoming revision 1 against stored revision 3 -> skip
  const staleRev1 = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 1, receiptRequired: true },
    stored: { timing: "prepay", revision: 3, receiptRequired: true },
    fresh: { status: "pending", fields: { timing: "prepay", revision: 3, receiptRequired: true } },
  });
  assert.equal(staleRev1.action, "skip");
  assert.equal(staleRev1.reason, "stale_payment_revision");

  // Incoming matching revision 3 -> send_requisites
  const freshRev3 = decidePaymentRequest({
    isReceiptRequest: true,
    event: { timing: "prepay", revision: 3, receiptRequired: true },
    stored: { timing: "prepay", revision: 3, receiptRequired: true },
    fresh: { status: "pending", fields: { timing: "prepay", revision: 3, receiptRequired: true } },
  });
  assert.equal(freshRev3.action, "send_requisites");
});

test("issue 4: 409 stale receipt replies adapt to order status without requesting payment for completed/cooking", () => {
  // Completed order -> do not request payment or new receipt
  const completedRu = buildStaleReceiptReply("ru", "prepay", "88", "completed");
  assert.match(completedRu, /уже выполнен/i);
  assert.match(completedRu, /не требуются/i);
  assert.doesNotMatch(completedRu, /актуальных реквизитов|новый чек/i);

  const completedKk = buildStaleReceiptReply("kk", "prepay", "88", "delivered");
  assert.match(completedKk, /орындалған/i);
  assert.match(completedKk, /қажет емес/i);
  assert.doesNotMatch(completedKk, /жаңа реквизиттер|жаңа чекті/i);

  // Cancelled or expired order -> do not request payment
  const cancelledRu = buildStaleReceiptReply("ru", "prepay", "88", "cancelled");
  assert.match(cancelledRu, /отменён/i);
  assert.match(cancelledRu, /не требуются/i);

  const expiredKk = buildStaleReceiptReply("kk", "prepay", "88", "expired");
  assert.match(expiredKk, /жойылған/i);
  assert.match(expiredKk, /қажет емес/i);

  // Preparing order -> cooking, no new receipt needed
  const preparingRu = buildStaleReceiptReply("ru", "prepay", "88", "preparing");
  assert.match(preparingRu, /уже готовится/i);
  assert.match(preparingRu, /повторный чек/i);

  const onTheWayKk = buildStaleReceiptReply("kk", "prepay", "88", "on_the_way");
  assert.match(onTheWayKk, /дайындалуда/i);
  assert.match(onTheWayKk, /қайта чек/i);

  // On receipt timing -> pay on receipt, no receipt needed
  const onReceiptRu = buildStaleReceiptReply("ru", "on_receipt", "88", "pending");
  assert.match(onReceiptRu, /оплачивается при получении/i);
  assert.match(onReceiptRu, /чек отправлять не нужно/i);

  // Still pending with changed prepay terms -> classic prompt for new requisites
  const pendingPrepayRu = buildStaleReceiptReply("ru", "prepay", "88", "pending");
  assert.match(pendingPrepayRu, /Условия оплаты по заказу изменились/i);
  assert.match(pendingPrepayRu, /Дождитесь актуальных реквизитов/i);
});

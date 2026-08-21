import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  ALEMI_COMMAND_PATH,
  ALEMI_ORDER_DOCUMENT_PATH,
  ALEMI_PRINT_RESULTS_PATH,
  buildAlemiSignedCommand,
  callAlemiCommand,
  createAlemiCommandId,
  issueCustomerAccessLink,
  mapLegacyAlemiAction,
  reportAnalyzedReceipt,
  reportOperatorSos,
  reportPrintResult,
  resolveAlemiCredentials,
  unwrapAlemiResponse,
  uploadOrderDocument,
  type AlemiTransportRequest,
} from "../src/services/alemiApi.service.js";
import { crmDailyLogEntry, updateCrmAction } from "../src/services/dle.service.js";

const config = {
  instance_id: "prestige",
  alemi_api_url: "https://hub.alemi.kz/",
  alemi_secret: "test-secret",
};

function expectedSignature(secret: string, timestamp: string, signedBytes: string) {
  return `v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${signedBytes}`, "utf8").digest("hex")}`;
}

test("generated command IDs match the Alemi schema accepted by production", () => {
  assert.match(createAlemiCommandId(), /^cmd_[A-F0-9]{26}$/);
});

test("Alemi command signs the exact ordered JSON bytes and emits the contract headers", () => {
  const request = buildAlemiSignedCommand({
    command: "runtime.status.get",
    data: {},
    credentials: { apiUrl: "https://hub.alemi.kz/", instance: "prestige", secret: "test-secret" },
    commandId: "cmd-fixed",
    nowMs: 1_700_000_000_123,
  });
  const expectedBody = "{\"command\":\"runtime.status.get\",\"command_id\":\"cmd-fixed\",\"data\":{},\"instance\":\"prestige\",\"schema_version\":1}";
  assert.equal(request.url, `https://hub.alemi.kz${ALEMI_COMMAND_PATH}`);
  assert.equal(request.rawBody, expectedBody);
  assert.equal(request.timestamp, "1700000000");
  assert.deepEqual(request.headers, {
    "content-type": "application/json",
    "X-Platform-Instance": "prestige",
    "X-Command-Id": "cmd-fixed",
    "X-Command-Timestamp": "1700000000",
    "X-Command-Signature": expectedSignature("test-secret", "1700000000", expectedBody),
  });
  assert.doesNotMatch(JSON.stringify(request), /test-secret/);
});

test("analyzed receipt command sends structured payment facts without the raw document", async () => {
  let captured: AlemiTransportRequest | null = null;
  const result = await reportAnalyzedReceipt({
    instanceId: "prestige",
    orderId: "01a0098e-d585-7071-bb22-6beaf5b740f5",
    sourceMessageId: "wa-receipt-28",
    phone: "87476884956",
    senderName: "Рахметоллаұлы Б.",
    amount: 8000,
    bankName: "Kaspi",
    text: "Рахметоллаұлы Б. сумма 8000 ₸ Kaspi",
  }, {
    config,
    commandId: "cmd-receipt-analysis",
    nowMs: 1_700_000_000_000,
    transport: async (request) => {
      captured = request;
      return { status: 201, data: { data: { receipt_analysis_id: "analysis-1", order_id: "01a0098e-d585-7071-bb22-6beaf5b740f5" } } };
    },
  });

  const body = JSON.parse(String(captured?.body || ""));
  assert.equal(body.command, "order.payment_receipt.analyzed");
  // Hub's published contract is exactly {order_id, source_message_id, text} -
  // any extra field (phone_e164, sender_name, amount_minor, ...) makes hub
  // answer 400 INTEGRATION_COMMAND_INVALID for the whole command, which the
  // delivery service then mistook for "command not implemented" and silently
  // fell back to the legacy document upload. The payment facts travel inside
  // `text`, formatted by formatReceiptOperatorComment.
  assert.deepEqual(body.data, {
    order_id: "01a0098e-d585-7071-bb22-6beaf5b740f5",
    source_message_id: "wa-receipt-28",
    text: "Рахметоллаұлы Б. сумма 8000 ₸ Kaspi",
  });
  assert.doesNotMatch(JSON.stringify(body.data), /phone_e164|sender_name|amount_minor|bank_name|currency/i);
  assert.doesNotMatch(JSON.stringify(body), /base64|receiptBase64|transaction|paidAt|file/i);
  assert.equal(result.receipt_analysis_id, "analysis-1");
});

test("legacy actions map to the documented Hub commands and data", () => {
  assert.deepEqual(mapLegacyAlemiAction("get_runtime_status", {}), { command: "runtime.status.get", data: {} });
  // The integration doc lists `order_id` on both order commands, but the live
  // hub answers 400 INTEGRATION_COMMAND_INVALID whenever it is present
  // (verified 2026-08-11). The requested order is selected from the returned
  // pools instead, so the field must not reach the wire.
  assert.deepEqual(mapLegacyAlemiAction("get_order_context", { phone: "87001112233", order_id: 41 }), {
    command: "order.context.get",
    data: { phone_e164: "+77001112233", limit: 5 },
  });
  assert.deepEqual(mapLegacyAlemiAction("check_status", { phone: "7001112233", order_id: "019fe7ca-1111-7111-8111-111111111111" }), {
    command: "order.status.get",
    data: { phone_e164: "+77001112233" },
  });
  assert.deepEqual(mapLegacyAlemiAction("get_menu_context", { lang: "kz" }), {
    command: "catalog.context.get",
    data: { locale: "kk" },
  });
  assert.deepEqual(mapLegacyAlemiAction("update_crm", {
    phone: "77001112233",
    interest: "pizza",
    sales_stage: "menu_sent",
    psycho_analysis: "brief",
  }), {
    command: "crm.lead.upsert",
    data: { phone_e164: "+77001112233", interest: "pizza", sales_stage: "menu_sent", psycho_analysis: "brief" },
  });
  assert.deepEqual(mapLegacyAlemiAction("get_today_crm", { date: "2026-08-09" }), {
    command: "crm.today.get",
    data: { date: "2026-08-09" },
  });
  assert.deepEqual(mapLegacyAlemiAction("save_daily_analytics", {
    report_date: "2026-08-09",
    total_chats: 7,
    total_complaints: 2,
    total_canceled: 1,
    conversion_rate: 0.5,
    popular_items: ["pizza"],
    critical_alert: "",
    ai_daily_advice: "keep pace",
  }), {
    command: "analytics.daily.upsert",
    data: {
      report_date: "2026-08-09",
      total_chats: 7,
      total_complaints: 2,
      total_canceled: 1,
      conversion_rate: 0.5,
      popular_items: ["pizza"],
      critical_alert: "",
      ai_daily_advice: "keep pace",
    },
  });
});

test("process-wide Alemi secrets cannot satisfy any SaaS tenant", () => {
  assert.throws(() => resolveAlemiCredentials("mack_center", {
    instance_id: "mack_center",
    secret_key: "unrelated-whatspro-secret",
  }, {
    ALEMI_API_URL: "https://hub.alemi.kz",
    ALEMI_INSTANCE: "mack_center",
    ALEMI_SECRET: "alemi-restaurant-secret",
  }), /ALEMI_SECRET_NOT_CONFIGURED/);

  assert.throws(() => resolveAlemiCredentials("second-restaurant", {
    instance_id: "second-restaurant",
  }, {
    ALEMI_API_URL: "https://hub.alemi.kz",
    ALEMI_INSTANCE: "mack_center",
    ALEMI_SECRET: "must-not-cross-tenants",
  }), /ALEMI_SECRET_NOT_CONFIGURED/);

  // env.ALEMI_INSTANCE used to stand in for a missing instance, so a call whose
  // tenant could not be determined was signed as the legacy restaurant with the
  // legacy secret - a cross-tenant write that looked like a successful call.
  assert.throws(() => resolveAlemiCredentials("", null, {
    ALEMI_API_URL: "https://hub.alemi.kz",
    ALEMI_INSTANCE: "mack_center",
    ALEMI_SECRET: "must-not-be-borrowed",
  }), /ALEMI_INSTANCE_NOT_CONFIGURED/);
  assert.throws(() => resolveAlemiCredentials("", { domain: "https://prestige.alemi.kz" }, {
    ALEMI_INSTANCE: "mack_center",
    ALEMI_SECRET: "must-not-be-borrowed",
  }), /ALEMI_INSTANCE_NOT_CONFIGURED/);
});

test("command transport receives exact raw body and common response envelopes unwrap", async () => {
  let captured: AlemiTransportRequest | null = null;
  const result = await callAlemiCommand("prestige", "catalog.context.get", { locale: "kk" }, {
    config,
    commandId: "cmd-menu",
    nowMs: 1_700_000_000_000,
    transport: async (request) => {
      captured = request;
      return { status: 200, data: { result: { items: [{ id: 1 }] } } };
    },
  });
  assert.deepEqual(result, { items: [{ id: 1 }] });
  assert.equal(typeof captured?.body, "string");
  assert.equal((captured?.body as string).includes('"locale":"kk"'), true);
  assert.deepEqual(unwrapAlemiResponse({ data: { ok: 1 } }), { ok: 1 });
  assert.deepEqual(unwrapAlemiResponse({ result: { ok: 2 } }), { ok: 2 });
  assert.deepEqual(unwrapAlemiResponse({ data: { result: { ok: 4 } } }), { ok: 4 });
  assert.deepEqual(unwrapAlemiResponse({ ok: 3 }), { ok: 3 });
});

test("tenant secret JSON and explicit per-tenant config resolve without exposing another tenant", () => {
  const env = {
    ALEMI_TENANT_SECRETS_JSON: JSON.stringify({
      alpha: { secret: "alpha-secret", api_url: "https://hub.alemi.kz", instance: "alpha" },
      beta: "beta-secret",
    }),
  };
  assert.deepEqual(resolveAlemiCredentials("alpha", null, env), {
    apiUrl: "https://hub.alemi.kz", instance: "alpha", secret: "alpha-secret",
  });
  assert.deepEqual(resolveAlemiCredentials("beta", null, env), {
    apiUrl: "https://hub.alemi.kz", instance: "beta", secret: "beta-secret",
  });
  assert.throws(() => resolveAlemiCredentials("missing", null, {}), /ALEMI_SECRET_NOT_CONFIGURED/);
});

test("non-2xx and rejected command responses fail closed", async () => {
  await assert.rejects(
    callAlemiCommand("prestige", "runtime.status.get", {}, {
      config,
      transport: async () => ({ status: 503, data: {} }),
    }),
    /ALEMI_HTTP_503/
  );
  await assert.rejects(
    callAlemiCommand("prestige", "runtime.status.get", {}, {
      config,
      transport: async () => ({ status: 200, data: { ok: false, error: { code: "bad_signature" } } }),
    }),
    /ALEMI_COMMAND_REJECTED/
  );
});

test("receipt upload signs canonical metadata and sends one multipart file field", async () => {
  const bytes = new TextEncoder().encode("receipt-bytes");
  let captured: AlemiTransportRequest | null = null;
  const result = await uploadOrderDocument({
    instanceId: "prestige",
    orderId: 77,
    sourceMessageId: "wa-message-1",
    bytes,
    mimeType: "image/png",
  }, {
    config,
    commandId: "upload-fixed",
    nowMs: 1_700_000_000_000,
    transport: async (request) => {
      captured = request;
      return { status: 201, data: { data: { document_id: "doc-1" } } };
    },
  });
  assert.deepEqual(result, { document_id: "doc-1" });
  assert.equal(captured?.url, `https://hub.alemi.kz${ALEMI_ORDER_DOCUMENT_PATH}`);
  assert.ok(captured?.body instanceof FormData);
  const file = (captured?.body as FormData).get("file") as Blob;
  assert.equal(Buffer.from(await file.arrayBuffer()).toString(), "receipt-bytes");
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const canonical = ["order-document-upload-v1", "upload-fixed", "prestige", "77", "wa-message-1", "receipt", "image/png", sha].join("\n");
  assert.equal(captured?.headers["X-Content-SHA256"], sha);
  assert.equal(captured?.headers["X-Command-Signature"], expectedSignature("test-secret", "1700000000", canonical));
});

test("legacy receipt action fails explicitly until raw bytes are wired to the upload helper", async () => {
  await assert.rejects(
    updateCrmAction("receipt", "prestige", "77001112233", { order_id: "77" }),
    /ALEMI_RECEIPT_BYTES_REQUIRED/
  );
});

// The CRM skill passes its whole tenant config so the hub call can sign without
// a second platform read. saveDailyLog JSON-stringifies its argument into
// `daily_logs:<instance>`, so spreading that config wrote alemi_secret into
// Redis, where crm.today.get and the analytics cron read from.
test("the CRM daily log carries the lead fields and no tenant credential", () => {
  const entry = crmDailyLogEntry("update_crm", "77001112233", {
    config,
    interest: "пицца",
    sales_stage: "MENU_SENT",
    psycho_analysis: "спешит",
  });
  assert.deepEqual(entry, {
    action: "update_crm",
    phone: "77001112233",
    interest: "пицца",
    sales_stage: "MENU_SENT",
    psycho_analysis: "спешит",
  });
  assert.doesNotMatch(JSON.stringify(entry), /test-secret|alemi_secret|hub\.alemi\.kz/);
});

test("customer access-link helper maps phone/locale and unwraps common URL keys", async () => {
  let body = "";
  const link = await issueCustomerAccessLink({
    instanceId: "prestige",
    phone: "87001112233",
    locale: "kk",
    config,
  }, {
    commandId: "link-fixed",
    nowMs: 1_700_000_000_000,
    transport: async (request) => {
      body = String(request.body);
      return { status: 200, data: { data: { access_url: "https://prestige.alemi.kz/?phone=77001112233&hash=baa4a6dc41085296b0b" } } };
    },
  });
  assert.equal(link, "https://prestige.alemi.kz/?phone=77001112233&hash=baa4a6dc41085296b0b");
  assert.match(body, /"command":"customer\.access_link\.issue"/);
  assert.match(body, /"phone_e164":"\+77001112233","locale":"kk"/);
});

test("print-result helper signs the documented canonical string", async () => {
  let captured: AlemiTransportRequest | null = null;
  await reportPrintResult({
    instanceId: "prestige",
    printJobId: "job-9",
    attemptNumber: 2,
    status: "failed",
    errorCode: "printer_offline",
    errorMessage: "Printer unavailable",
  }, {
    config,
    commandId: "print-fixed",
    nowMs: 1_700_000_000_000,
    transport: async (request) => {
      captured = request;
      return { status: 200, data: { ok: true } };
    },
  });
  assert.equal(captured?.url, `https://hub.alemi.kz${ALEMI_PRINT_RESULTS_PATH}`);
  const canonical = [
    "print-result-v1",
    "print-fixed",
    "prestige",
    "job-9",
    "2",
    "failed",
    "",
    "printer_offline",
    "Printer unavailable",
  ].join("\n");
  assert.equal(captured?.headers["X-Command-Signature"], expectedSignature("test-secret", "1700000000", canonical));
  assert.equal(captured?.body, JSON.stringify({
    print_job_id: "job-9",
    attempt_number: 2,
    status: "failed",
    external_reference: "",
    error_code: "printer_offline",
    error_message: "Printer unavailable",
  }));
});

test("reportOperatorSos sends operator.sos.raised with exactly the published contract fields", async () => {
  let captured: any;
  await reportOperatorSos({
    instanceId: "prestige",
    caseId: "oc_1786297320392_31e27989",
    signalId: "sos_1787213240021_793308ea",
    phone: "8 747 688-49-56",
    kind: "complaint",
    summary: "Тапсырыс екі сағатқа кешікті, тағам суық келді",
    orderNumber: "13",
    createdAt: 1_700_000_000_000,
  }, {
    config,
    commandId: "cmd-sos-raised-1",
    nowMs: 1_700_000_000_000,
    transport: async (request: any) => { captured = request; return { status: 200, data: { ok: true } }; },
  });

  const body = JSON.parse(String(captured?.body || ""));
  assert.equal(body.command, "operator.sos.raised");
  assert.equal(body.command_id, "cmd-sos-raised-1");
  assert.equal(body.instance, "prestige");
  // The site contract is exactly this field set - hub dedupes on signal_id.
  assert.deepEqual(Object.keys(body.data).sort(), ["case_id", "created_at", "kind", "order_number", "phone", "signal_id", "summary"]);
  assert.equal(body.data.case_id, "oc_1786297320392_31e27989");
  assert.equal(body.data.signal_id, "sos_1787213240021_793308ea");
  assert.equal(body.data.phone, "87476884956");
  assert.equal(body.data.kind, "complaint");
  assert.equal(body.data.order_number, "13");
  assert.equal(body.data.created_at, 1_700_000_000_000);
});

test("reportOperatorSos omits optional fields and validates the idempotency keys", async () => {
  let captured: any;
  await reportOperatorSos({
    instanceId: "prestige", caseId: "oc_1", signalId: "sos_1",
    phone: "77476884956", kind: "human_request", summary: "",
  }, {
    config,
    transport: async (request: any) => { captured = request; return { status: 200, data: { ok: true } }; },
  });
  const body = JSON.parse(String(captured?.body || ""));
  assert.equal(body.data.summary, undefined);
  assert.equal(body.data.order_number, undefined);
  assert.equal(typeof body.data.created_at, "number");

  await assert.rejects(
    () => reportOperatorSos({ instanceId: "prestige", caseId: "", signalId: "sos_1", phone: "7747", kind: "complaint", summary: "x" }, { config }),
    /ALEMI_CASE_ID_REQUIRED/);
  await assert.rejects(
    () => reportOperatorSos({ instanceId: "prestige", caseId: "oc_1", signalId: "", phone: "7747", kind: "complaint", summary: "x" }, { config }),
    /ALEMI_SIGNAL_ID_REQUIRED/);
  await assert.rejects(
    () => reportOperatorSos({ instanceId: "prestige", caseId: "oc_1", signalId: "sos_1", phone: "", kind: "complaint", summary: "x" }, { config }),
    /ALEMI_PHONE_REQUIRED/);
});

test("a guest with no active order raises the SOS without a placeholder order reference", async () => {
  // Hub answers 400 INTEGRATION_COMMAND_INVALID for the whole command when
  // order_number carries an escalation placeholder, which silently dropped
  // every SOS raised without an active order and left the site with nothing to
  // notify until the operator opened the chat panel (live hub, 2026-08-21).
  const raise = async (orderNumber: string) => {
    let captured: any;
    await reportOperatorSos({
      instanceId: "prestige",
      caseId: "oc_1787323244566_19699ad0",
      signalId: `sos_${orderNumber || "empty"}`,
      phone: "77476884956",
      kind: "human_request",
      summary: "Клиент операторға жалғағысы келеді",
      orderNumber,
    }, {
      config,
      transport: async (request: any) => { captured = request; return { status: 200, data: { ok: true } }; },
    });
    return JSON.parse(String(captured?.body || "")).data;
  };

  for (const placeholder of ["not_found", "NOT_FOUND", "Not Found", "unknown", "none", "-", "n/a"]) {
    assert.equal((await raise(placeholder)).order_number, undefined, placeholder);
  }
  // A real reference still travels: the site links the signal to the order.
  assert.equal((await raise("01a02453-f171-79f4-b340-0ca1901dec0f")).order_number, "01a02453-f171-79f4-b340-0ca1901dec0f");
  assert.equal((await raise("13")).order_number, "13");
});

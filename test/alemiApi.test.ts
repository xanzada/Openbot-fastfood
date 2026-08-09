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
  reportPrintResult,
  resolveAlemiCredentials,
  unwrapAlemiResponse,
  uploadOrderDocument,
  type AlemiTransportRequest,
} from "../src/services/alemiApi.service.js";
import { updateCrmAction } from "../src/services/dle.service.js";

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

test("legacy actions map to the documented Hub commands and data", () => {
  assert.deepEqual(mapLegacyAlemiAction("get_runtime_status", {}), { command: "runtime.status.get", data: {} });
  assert.deepEqual(mapLegacyAlemiAction("get_order_context", { phone: "87001112233", order_id: 41 }), {
    command: "order.context.get",
    data: { phone_e164: "+77001112233", limit: 5, order_id: "41" },
  });
  assert.deepEqual(mapLegacyAlemiAction("check_status", { phone: "7001112233", order_id: "019fe7ca-1111-7111-8111-111111111111" }), {
    command: "order.status.get",
    data: { phone_e164: "+77001112233", order_id: "019fe7ca-1111-7111-8111-111111111111" },
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

test("single-tenant Alemi env is used only for its explicitly named legacy tenant", () => {
  const credentials = resolveAlemiCredentials("mack_center", {
    instance_id: "mack_center",
    secret_key: "unrelated-whatspro-secret",
  }, {
    ALEMI_API_URL: "https://hub.alemi.kz",
    ALEMI_INSTANCE: "mack_center",
    ALEMI_SECRET: "alemi-restaurant-secret",
  });
  assert.deepEqual(credentials, {
    apiUrl: "https://hub.alemi.kz",
    instance: "mack_center",
    secret: "alemi-restaurant-secret",
  });

  assert.throws(() => resolveAlemiCredentials("second-restaurant", {
    instance_id: "second-restaurant",
  }, {
    ALEMI_API_URL: "https://hub.alemi.kz",
    ALEMI_INSTANCE: "mack_center",
    ALEMI_SECRET: "must-not-cross-tenants",
  }), /ALEMI_SECRET_NOT_CONFIGURED/);
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
  assert.deepEqual(resolveAlemiCredentials("alpha", null, {
    ALEMI_TENANT_SECRETS_JSON: JSON.stringify({
      alpha: { secret: "alpha-secret", api_url: "https://hub.alemi.kz", instance: "alpha" },
      beta: "beta-secret",
    }),
  }), { apiUrl: "https://hub.alemi.kz", instance: "alpha", secret: "alpha-secret" });
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
      return { status: 200, data: { data: { access_url: "https://alemi.kz/access/one" } } };
    },
  });
  assert.equal(link, "https://alemi.kz/access/one");
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

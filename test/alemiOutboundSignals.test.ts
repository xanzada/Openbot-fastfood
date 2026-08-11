import test from "node:test";
import assert from "node:assert/strict";
import {
  issueCustomerAccessLink,
  reportPrintResult,
  uploadOrderDocument,
  type AlemiTransportRequest,
} from "../src/services/alemiApi.service.js";
import { normalizeRuntimeStatus } from "../src/services/dle.service.js";

// Every outbound write to hub.alemi.kz is retried once when the operator has
// rotated the Secret Key in the WhatsPro UI. callAlemiCommand was fixed to keep
// the SAME command_id across that retry; the two non-command endpoints - the
// receipt upload and the print result - still minted a fresh id inside the retry
// callback, so hub saw the re-send as a different operation and its idempotency
// had nothing to match on.
//
// The runtime-status half of this file is the payment-requisite fallback: hub
// answers `payment_details: []` at the top level for prestige and carries the
// operator's Kaspi/Halyk numbers under `kitchen_status.payment_details`, and the
// old `a || b` chain could never reach them because [] is truthy.

const config = {
  instance_id: "prestige",
  alemi_api_url: "https://hub.alemi.kz/",
  alemi_secret: "old-secret",
};

function rotatingTransport(sent: AlemiTransportRequest[]) {
  return async (request: AlemiTransportRequest) => {
    sent.push(request);
    if (sent.length === 1) return { status: 401, data: { ok: false } };
    return { status: 200, data: { ok: true, data: { document_id: "doc-1", order_id: "77" } } };
  };
}

test("a receipt re-sent after a rotated secret is ONE payment proof on the order, not two", async () => {
  const sent: AlemiTransportRequest[] = [];
  let refreshes = 0;
  await uploadOrderDocument({
    instanceId: "prestige",
    orderId: 77,
    sourceMessageId: "wa-message-1",
    bytes: new TextEncoder().encode("receipt-bytes"),
    mimeType: "image/png",
  }, {
    config,
    nowMs: 1_700_000_000_000,
    refreshConfig: async () => {
      refreshes += 1;
      return { instance_id: "prestige", alemi_secret: "new-secret" };
    },
    transport: rotatingTransport(sent),
  });
  assert.equal(sent.length, 2);
  assert.equal(refreshes, 1);
  assert.equal(sent[0].headers["X-Command-Id"], sent[1].headers["X-Command-Id"]);
  // Signed with different secrets, so the signature must differ while the
  // operation identity does not.
  assert.notEqual(sent[0].headers["X-Command-Signature"], sent[1].headers["X-Command-Signature"]);
});

test("a print result re-sent after a rotated secret reports one attempt, not two", async () => {
  const sent: AlemiTransportRequest[] = [];
  await reportPrintResult({
    instanceId: "prestige",
    printJobId: "job-9",
    attemptNumber: 1,
    status: "failed",
    errorCode: "printer_offline",
    errorMessage: "No printer client connected",
  }, {
    config,
    nowMs: 1_700_000_000_000,
    refreshConfig: async () => ({ instance_id: "prestige", alemi_secret: "new-secret" }),
    transport: rotatingTransport(sent),
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[0].headers["X-Command-Id"], sent[1].headers["X-Command-Id"]);
});

test("a hub 200 that carries no usable URL never reaches the guest as their menu link", async () => {
  const bodies: unknown[] = [
    "<html><body>502 Bad Gateway</body></html>",
    { data: { url: "pending" } },
    { data: {} },
  ];
  for (const data of bodies) {
    const link = await issueCustomerAccessLink({
      instanceId: "prestige",
      phone: "87001112233",
      locale: "kk",
      config,
    }, {
      nowMs: 1_700_000_000_000,
      transport: async () => ({ status: 200, data }),
    });
    assert.equal(link, null, `unusable body must not become a link: ${JSON.stringify(data)}`);
  }

  const good = await issueCustomerAccessLink({
    instanceId: "prestige",
    phone: "87001112233",
    locale: "kk",
    config,
  }, {
    nowMs: 1_700_000_000_000,
    transport: async () => ({ status: 200, data: { data: { access_url: "https://alemi.kz/access/one" } } }),
  });
  assert.equal(good, "https://alemi.kz/access/one");
});

test("requisites typed into the site kitchen settings are quoted even when hub sends payment_details: []", () => {
  // The exact shape the live hub returned for prestige on 2026-08-12: an empty
  // top-level payment_details next to a kitchen_status object that carries the
  // requisites.
  const status = normalizeRuntimeStatus({
    is_accepting_orders: true,
    within_work_hours: true,
    closed_reason: "",
    delivery: true,
    pickup: true,
    wait_time: 30,
    reset_at: 0,
    is_emergency: false,
    payment_details: [],
    kitchen_status: {
      wait_time: 30,
      reset_at: 0,
      delivery: true,
      pickup: true,
      is_emergency: false,
      payment_details: [
        { label: "Kaspi", value: "+7 700 111 22 33" },
        { label: "Halyk", value: "KZ123456789" },
      ],
    },
  });
  assert.deepEqual(status.payment_details, [
    { label: "Kaspi", value: "+7 700 111 22 33", source: undefined },
    { label: "Halyk", value: "KZ123456789", source: undefined },
  ]);
});

test("a runtime status with no requisites anywhere still reports none, so the guest waits for the operator", () => {
  const status = normalizeRuntimeStatus({
    is_accepting_orders: true,
    payment_details: [],
    kitchen_status: { wait_time: 30, payment_details: [] },
  });
  assert.deepEqual(status.payment_details, []);
});

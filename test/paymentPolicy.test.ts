import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";
import { ONLINE_PREPAYMENT_POLICY } from "../src/services/paymentPolicy.service.js";
import {
  reportAnalyzedReceipt,
  type AlemiTransportRequest,
} from "../src/services/alemiApi.service.js";

test("orders require online prepayment and reject payment on fulfillment", () => {
  assert.deepEqual(ONLINE_PREPAYMENT_POLICY, {
    mode: "online_prepayment_only",
    prepaymentRequired: true,
    cashAccepted: false,
    payOnDeliveryAccepted: false,
    payOnPickupAccepted: false,
    rule: "Payment is online and prepaid only. Cash, payment on delivery, and payment on pickup are not accepted.",
  });
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Every order requires online prepayment before fulfillment/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /Cash, payment to the courier on delivery, and payment on pickup are not available/);
});

test("facts context exposes the mandatory online prepayment policy", () => {
  const prompt = buildFactsPrompt({
    language: "ru",
    languagePolicy: {},
    instanceId: "tenant-a",
    config: { brand: "Test" },
    senderMeta: {},
    hardRealtimeContext: {},
    runtimeStatus: {},
    activeShiftNotes: [],
    magicLinkAlreadySent: false,
    explicitMenuLinkIntent: false,
    magicLink: "",
    chatHistory: [],
    shporContext: [],
  } as any);

  const json = prompt.slice(prompt.indexOf("\n") + 1, prompt.lastIndexOf("\n"));
  const facts = JSON.parse(json);
  assert.deepEqual(facts.payment_policy, ONLINE_PREPAYMENT_POLICY);
});

test("payment tool returns the same strict policy with live requisites", async () => {
  const source = await readFile(new URL("../src/skills/payment.skill.ts", import.meta.url), "utf8");
  assert.match(source, /paymentPolicy: ONLINE_PREPAYMENT_POLICY/);
  assert.match(source, /Payment is online and prepaid only/);
  assert.match(source, /Cash and payment on delivery or pickup are not accepted/);
});

test("payment confirmation only signals the operator and never marks an order paid", async () => {
  let captured: AlemiTransportRequest | null = null;
  await reportAnalyzedReceipt({
    instanceId: "tenant-a",
    orderId: "order-42",
    sourceMessageId: "wa-proof-42",
    phone: "87769156184",
    senderName: "Customer B.",
    amount: 8000,
    bankName: "Kaspi",
  }, {
    config: { instance_id: "tenant-a", alemi_instance: "tenant-a", alemi_secret: "tenant-a-secret" },
    commandId: "cmd-payment-policy",
    transport: async (request) => {
      captured = request;
      return { status: 201, data: { result: { accepted: true } } };
    },
  });

  const body = JSON.parse(String(captured?.body || ""));
  assert.equal(body.command, "order.payment_receipt.analyzed");
  assert.equal(body.data.amount_minor, 800000);
  assert.doesNotMatch(JSON.stringify(body), /mark_paid|status_paid|confirm_payment|print_trigger/i);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";
import { PAYMENT_POLICY, paymentPolicyForOrder } from "../src/services/paymentPolicy.service.js";
import {
  reportAnalyzedReceipt,
  type AlemiTransportRequest,
} from "../src/services/alemiApi.service.js";

test("prepayment stays the default and pay on receipt is neither promised nor denied", () => {
  assert.equal(PAYMENT_POLICY.mode, "prepay_default_on_receipt_optional");
  assert.equal(PAYMENT_POLICY.defaultTiming, "prepay");
  assert.match(PAYMENT_POLICY.payOnReceipt, /Never promise it is available and never say it is impossible/);
  assert.match(PAYMENT_POLICY.rule, /Never send requisites or ask for a receipt for an order whose payment timing is on_receipt/);
  assert.doesNotMatch(FASTFOOD_AGENT_INSTRUCTIONS, /Online prepaid only|prepaid only|pay-on-delivery are not available/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /«При получении»/);
  assert.match(FASTFOOD_AGENT_INSTRUCTIONS, /never send requisites or ask for a receipt/);
});

test("an on_receipt order is reported to the agent as such", () => {
  assert.equal(paymentPolicyForOrder(null).active_order_payment_timing, "no_active_order");
  assert.equal(paymentPolicyForOrder({ order: { id: "o1", status: "pending" } }).active_order_payment_timing, "prepay");
  const onReceipt = paymentPolicyForOrder({ order: { id: "o1", payment_timing: "on_receipt", payment_revision: 2 } });
  assert.equal(onReceipt.active_order_payment_timing, "on_receipt");
  assert.match(String(onReceipt.active_order_rule), /no requisites, no receipt/);
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
  assert.deepEqual(facts.payment_policy, paymentPolicyForOrder(null));
});

test("payment tool returns the order-aware policy with live requisites", async () => {
  const source = await readFile(new URL("../src/skills/payment.skill.ts", import.meta.url), "utf8");
  assert.match(source, /paymentPolicyForOrder\(ctx\.activeOrder\)/);
  assert.match(source, /order_on_receipt/);
  assert.doesNotMatch(source, /prepaid only/);
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
  // Hub accepts exactly {order_id, source_message_id, text} for this command;
  // amount/bank/sender travel inside `text` only. No `text` was passed here,
  // so the payload is the bare id pair.
  assert.deepEqual(Object.keys(body.data).sort(), ["order_id", "source_message_id"]);
  assert.doesNotMatch(JSON.stringify(body), /mark_paid|status_paid|confirm_payment|print_trigger/i);
});

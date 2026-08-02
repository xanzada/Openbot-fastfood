import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { FASTFOOD_AGENT_INSTRUCTIONS } from "../src/agent/instructions.js";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";
import { ONLINE_PREPAYMENT_POLICY } from "../src/services/paymentPolicy.service.js";

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
  const source = await readFile(new URL("../api_bot.php", import.meta.url), "utf8");

  assert.match(
    source,
    /add_payment_comment'[\s\S]{0,120}confirm_payment_and_print/,
    "the legacy action must use the receipt-comment signal path"
  );
  assert.doesNotMatch(source, /SET\s+status\s*=\s*'paid'/i);
  assert.doesNotMatch(source, /\/api\/print_trigger/);
  assert.doesNotMatch(source, /CURLOPT_SSL_VERIFY(?:HOST|PEER)\s*,\s*false/);
  assert.match(source, /'status_changed'\s*=>\s*false/);
});

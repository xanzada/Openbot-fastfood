import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildBlockedMenuItemReply,
  buildUnverifiedPaymentClaimReply,
  findBlockedMenuItemMention,
  isUnverifiedPaymentClaim,
} from "../src/services/operationalPreemption.service.js";
import { isProspectiveOrderTimingQuestion } from "../src/utils/orderIntent.js";

test("live: a new-order ETA question is not hijacked by an older active order", () => {
  assert.equal(
    isProspectiveOrderTimingQuestion("казир заказ берсем канша кутем, доставка кашан келед?"),
    true,
  );
  assert.equal(
    isProspectiveOrderTimingQuestion("58 заказым кашан дайын болады?"),
    false,
  );
});

test("live: a compound availability plus ordering phrase obeys the active note", () => {
  const item = findBlockedMenuItemMention(
    [{ noteId: "e2e-1", text: "Футомаки временно нет" }],
    [{ name: "Футомаки", price: 2300, category: "Суши", composition: "" }],
    "ал енди футомаки барма, заказ бере аламба?",
  );

  assert.equal(item?.name, "Футомаки");
  const reply = buildBlockedMenuItemReply(item!, "kk");
  assert.match(reply, /уақытша қолжетімсіз/u);
  assert.doesNotMatch(reply, /https?:\/\/|prestige\.bekaba\.com/iu);
});

test("live: a text-only payment claim asks for proof and never claims paid", () => {
  const text = "60 заказга 1000 тг аудардым, paid кылып жбер";
  assert.equal(isUnverifiedPaymentClaim(text), true);
  assert.equal(isUnverifiedPaymentClaim("каспиге кай номерге аударам?"), false);

  const reply = buildUnverifiedPaymentClaimReply("kk");
  assert.match(reply, /чек|скрин/iu);
  assert.match(reply, /оператор/iu);
  assert.doesNotMatch(reply, /төлем (?:расталды|қабылданды)|\bpaid\b|https?:\/\//iu);
});

test("live guards execute before order-status and the LLM path", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const guard = source.indexOf("operationalPreemptionReply(ctx)");
  const status = source.indexOf("customerOrderReply(ctx)", guard);
  const agent = source.indexOf("runFastFoodAgent(ctx)", guard);

  assert.ok(guard >= 0, "physical-test guard must be wired into the webhook");
  assert.ok(status > guard, "payment/note truth must outrank an older order status");
  assert.ok(agent > guard, "deterministic live-state guards must save the AI call");
});

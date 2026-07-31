import test from "node:test";
import assert from "node:assert/strict";
import { validateFinalText } from "../src/agent/finalValidator.js";

function ctx(overrides: Record<string, any> = {}) {
  return {
    language: "ru",
    languagePolicy: {},
    instanceId: "tenant-a",
    config: { brand: "Test" },
    senderMeta: {},
    runtimeStatus: { kitchen_status: { wait_time: 0 } },
    fetchedSettings: { wait_time: 0 },
    hardRealtimeContext: {},
    activeOrder: null,
    magicLinkAlreadySent: false,
    explicitMenuLinkIntent: false,
    magicLink: "",
    chatHistory: [],
    shporContext: [],
    activeShiftNotes: [],
    ...overrides,
  } as any;
}

test("an ungrounded price claim is cut while the rest of the answer survives", () => {
  const out = validateFinalText("Могу подсказать по меню. Пицца стоит 2500 тенге.", ctx(), { toolsCalled: [] });
  assert.match(out.text, /Могу подсказать по меню/);
  assert.doesNotMatch(out.text, /2500/);
  assert.ok(out.warnings.includes("ungrounded_price_claim_removed"));
});

test("a price grounded by a live menu lookup is kept", () => {
  const out = validateFinalText("Пицца Маргарита стоит 2500 тенге.", ctx(), { toolsCalled: ["searchMenu"] });
  assert.match(out.text, /2500 тенге/);
  assert.ok(!out.warnings.some((warning) => warning.startsWith("ungrounded_price")));
});

test("order and payment tools also ground amounts", () => {
  for (const tool of ["checkOrderStatus", "getPaymentDetails"]) {
    const out = validateFinalText("Сумма к оплате 2500 тенге.", ctx(), { toolsCalled: [tool] });
    assert.match(out.text, /2500 тенге/, tool);
  }
});

test("an ungrounded promo claim is removed", () => {
  const out = validateFinalText("Загляните в меню. У нас есть акция, скидка 20% на всё.", ctx(), { toolsCalled: [] });
  assert.match(out.text, /Загляните в меню/);
  assert.doesNotMatch(out.text, /20%/);
  assert.ok(out.warnings.includes("unverified_promo_claim_removed"));
});

test("older callers without a grounding report behave exactly as before", () => {
  const out = validateFinalText("Пицца стоит 2500 тенге.", ctx());
  assert.match(out.text, /2500 тенге/);
});

test("a lone ungrounded claim is never replaced with a dead fallback", () => {
  const out = validateFinalText("Пицца стоит 2500 тенге.", ctx(), { toolsCalled: [] });
  assert.ok(out.text.length > 0);
  assert.ok(out.warnings.includes("ungrounded_price_claim_kept_no_survivor"));
});

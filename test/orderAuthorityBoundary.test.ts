import test from "node:test";
import assert from "node:assert/strict";
import { validateFinalText } from "../src/agent/finalValidator.js";
import {
  normalizeMediaAnalysisResponse,
  voiceTranscriptForAgent,
} from "../src/services/mediaAnalysis.service.js";
import {
  isLanguageBearingCustomerText,
  lastCustomerLanguage,
} from "../src/utils/language.js";
import { resolveAgentToolPlan } from "../src/agent/toolPolicy.js";
import { compactConversationHistory } from "../src/context/buildFactsPrompt.js";
import { refreshCheckoutContextForText } from "../src/services/checkoutIntent.service.js";
import { hasExplicitMenuLinkIntent } from "../src/utils/magicLink.js";

function context(language: "kk" | "ru" = "kk") {
  return {
    language,
    activeOrder: { order_id: "old-real-order" },
    runtimeStatus: { accepting_orders: true },
    hardRealtimeContext: { stale: false },
    fetchedSettings: { wait_time: 0 },
    magicLink: "https://menu.alemi.kz/auth/whatsapp#token=test",
    magicLinkAlreadySent: true,
    explicitMenuLinkIntent: false,
  } as any;
}

test("the final validator never lets the AI accept or confirm an order", () => {
  const first = validateFinalText(
    "Иә, дәл қазір екі донерге тапсырыс қабылдай аламыз. Жеткізу мекенжайын жазыңыз.",
    context("kk"),
    { toolsCalled: [] },
  );
  assert.match(first.text, /тапсырыс.*рәсімделген жоқ|мәзір сілтемесі/iu);
  assert.equal(first.warnings.includes("manual_order_claim_blocked"), true);

  const second = validateFinalText(
    "Отлично, приняли адрес: Брусиловский 18. Ваш заказ на два донера подтвержден.",
    context("kk"),
    { toolsCalled: [] },
  );
  assert.equal(second.text, "Тапсырыс әлі рәсімделген жоқ. Оны тек жеке мәзір сілтемесі арқылы өзіңіз жасай аласыз.");

  const groundedStatus = validateFinalText(
    "№12 тапсырысыңыз қабылданды, қазір дайындалып жатыр.",
    context("kk"),
    { toolsCalled: ["checkOrderStatus"] },
  );
  assert.equal(groundedStatus.warnings.includes("manual_order_claim_blocked"), false);
});

test("voice media returns a transcript to the main agent instead of becoming a final answer", () => {
  const analysis = normalizeMediaAnalysisResponse(JSON.stringify({
    type: "reply",
    transcript: "Екі донерге тапсырыс бергім келеді",
    analysis: "Әрине, тапсырысыңызды қабылдаймын",
  }));
  assert.equal(voiceTranscriptForAgent(analysis, "audio/ogg"), "Екі донерге тапсырыс бергім келеді");
  const plan = resolveAgentToolPlan({
    ...context("kk"),
    text: voiceTranscriptForAgent(analysis, "audio/ogg"),
  });
  assert.equal(plan.requiredTools.includes("sendMenuLink"), true);
});

test("a bare delivery address keeps the established Kazakh conversation language", () => {
  assert.equal(isLanguageBearingCustomerText("Брусиловский 18"), false);
  assert.equal(lastCustomerLanguage([
    { role: "user", text: "Екі донерге тапсырыс бергім келеді" },
    { role: "user", text: "Брусиловский 18" },
  ]), "kk");
});

test("fabricated order acceptance is excluded from the agent working memory", () => {
  const compact = compactConversationHistory([
    { role: "user", text: "Екі донерге тапсырыс бергім келеді", createdAt: 1 },
    {
      role: "assistant",
      source: "openbot-agent",
      text: "Тапсырысыңызды қабылдадым. Жеткізу мекенжайын жазыңыз.",
      createdAt: 2,
    },
    {
      role: "model",
      source: "hub_notification",
      text: "№12 тапсырысыңыз сайтта расталды.",
      createdAt: 3,
    },
  ]);

  assert.equal(compact.some((entry) => entry.text.includes("қабылдадым")), false);
  assert.equal(compact.some((entry) => entry.text.includes("сайтта расталды")), true);
  assert.equal(compact.some((entry) => entry.role === "user"), true);
});

test("a voice transcript hydrates the personal checkout link before the agent runs", async () => {
  const ctx = {
    ...context("kk"),
    instanceId: "prestige",
    phone: "77476884956",
    config: {},
    chatHistory: [],
    explicitMenuLinkIntent: false,
    magicLink: null,
    magicLinkFailed: false,
  } as any;
  let issued = 0;
  await refreshCheckoutContextForText(ctx, "Екі донер заказ берейін деп едім, қазір керек", {
    issueAccessLink: async () => {
      issued += 1;
      return "https://menu.alemi.kz/personal";
    },
    upsertLead: async () => true,
  });

  assert.equal(issued, 1);
  assert.equal(ctx.explicitMenuLinkIntent, true);
  assert.equal(ctx.magicLink, "https://menu.alemi.kz/personal");
  const plan = resolveAgentToolPlan({ ...ctx, text: "Екі донер заказ берейін деп едім" });
  assert.equal(plan.requiredTools[0], "sendMenuLink");
});

test("mixed-language requests to accept an order route to checkout, never address collection", () => {
  assert.equal(hasExplicitMenuLinkIntent("Заказ қабылдашы"), true);
  const blocked = validateFinalText("Жеткізу мекенжайын растай аласыз ба?", context("kk"), { toolsCalled: ["searchMenu"] });
  assert.equal(blocked.warnings.includes("manual_order_claim_blocked"), true);
});

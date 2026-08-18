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
});

test("voice media returns a transcript to the main agent instead of becoming a final answer", () => {
  const analysis = normalizeMediaAnalysisResponse(JSON.stringify({
    type: "reply",
    transcript: "Екі донерге тапсырыс бергім келеді",
    analysis: "Әрине, тапсырысыңызды қабылдаймын",
  }));
  assert.equal(voiceTranscriptForAgent(analysis, "audio/ogg"), "Екі донерге тапсырыс бергім келеді");
});

test("a bare delivery address keeps the established Kazakh conversation language", () => {
  assert.equal(isLanguageBearingCustomerText("Брусиловский 18"), false);
  assert.equal(lastCustomerLanguage([
    { role: "user", text: "Екі донерге тапсырыс бергім келеді" },
    { role: "user", text: "Брусиловский 18" },
  ]), "kk");
});

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeMedia,
  normalizeMediaAnalysisResponse,
  validateReceiptAnalysis,
  voiceTranscriptForAgent,
} from "../src/services/mediaAnalysis.service.js";

// Exercise the real provider -> normalizer -> catch path without network access.
function mockMediaResponse(t: TestContext, rawText: string) {
  const values = {
    OPENROUTER_API_KEY: "fixture-media-key",
    MEDIA_USE_FREE_KEYS: "false",
    MEDIA_PRO_ENABLED: "false",
  };
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  t.mock.method(console, "info", () => {});
  const errors = t.mock.method(console, "error", () => {});
  const fetch = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({
    choices: [{ message: { content: rawText } }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  return { fetch, errors };
}

const malformedResponses = [
  ["truncated receipt", '{"type":"receipt","amount":'],
  ["trailing comma", '{"type":"receipt","amount":100,}'],
  ["truncated outer object", '{"nested":{"type":"receipt"}'],
  ["provider prose", "RAW_PROVIDER_FAILURE: unable to read file"],
  ["empty response", ""],
  ["null", "null"],
  ["scalar", "42"],
  ["string containing braces", '"{not an object}"'],
  ["array", '[{"type":"receipt","amount":100}]'],
] as const;

for (const [label, rawText] of malformedResponses) {
  test(`rejects ${label} instead of normalizing it as a customer reply`, () => {
    assert.throws(() => normalizeMediaAnalysisResponse(rawText), {
      message: "MEDIA_ANALYSIS_INVALID_JSON",
    });
  });
}

const receipt = {
  type: "receipt",
  analysis: "Чек оқылды",
  amount: 2000,
  bank_name: "Kaspi",
  sender_name: "Fixture Sender",
  order_id: "fixture-order",
  date_time: "2026-09-10T06:00:00.000Z",
  transaction_id: "fixture-transaction",
  is_valid_receipt: true,
};

test("valid plain and fenced receipt JSON retain their fields and validation", () => {
  const plain = normalizeMediaAnalysisResponse(JSON.stringify(receipt));
  for (const fence of ["json", "JSON", ""]) {
    assert.deepEqual(normalizeMediaAnalysisResponse(`\`\`\`${fence}\n${JSON.stringify(receipt)}\n\`\`\``), plain);
  }
  for (const [key, value] of Object.entries(receipt)) assert.equal(plain[key as keyof typeof plain], value);
  assert.deepEqual(validateReceiptAnalysis(plain, {
    expectedAmount: 1990,
    orderCreatedAt: "2026-09-10T05:50:00.000Z",
    nowMs: Date.parse("2026-09-10T06:10:00.000Z"),
  }), { valid: true, reason: "ok" });
});

test("valid complaint keeps evidence, summary and customer-reply fallback", () => {
  const result = normalizeMediaAnalysisResponse(JSON.stringify({
    type: "complaint",
    admin_summary: " Тағамда бөгде зат бар ",
    reply_to_customer: " Кешіріңіз, шағымыңызды жеткіздім. ",
    evidence_visible: true,
    evidence_detail: " Қай тағамнан шықты? ",
  }));
  assert.equal(result.type, "complaint");
  assert.equal(result.admin_summary, "Тағамда бөгде зат бар");
  assert.equal(result.analysis, "Кешіріңіз, шағымыңызды жеткіздім.");
  assert.equal(result.evidence_visible, true);
  assert.equal(result.evidence_detail, "Қай тағамнан шықты?");
});

test("valid fenced voice response still reaches the main agent as a transcript", async (t) => {
  const rawText = '```json\n{"type":"reply","transcript":" Екі донер керек ","analysis":"fixture analysis"}\n```';
  const { fetch, errors } = mockMediaResponse(t, rawText);
  const result = await analyzeMedia("data:audio/ogg;base64,Zml4dHVyZQ==", "audio/ogg");
  assert.ok(result);
  assert.equal(result.type, "reply");
  assert.equal(voiceTranscriptForAgent(result, "audio/ogg"), "Екі донер керек");
  assert.equal(voiceTranscriptForAgent(result, "image/png"), "");
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(errors.mock.callCount(), 0);
});

for (const language of ["kk", "ru"] as const) {
  for (const mimeType of ["image/png", "application/pdf", "audio/ogg"]) {
    test(`malformed ${mimeType} analysis uses the existing ${language} technical-error path`, async (t) => {
      const rawText = '{"type":"receipt","analysis":"RAW_PROVIDER_FAILURE",';
      const { fetch, errors } = mockMediaResponse(t, rawText);
      const result = await analyzeMedia("Zml4dHVyZQ==", mimeType, "", language, mimeType === "application/pdf");
      assert.ok(result);
      assert.equal(result.type, "technical_error");
      assert.equal(result.validation_reason, "technical_error");
      assert.equal(result.is_valid_receipt, false);
      assert.equal("reply_to_customer" in result && result.reply_to_customer, language === "ru"
        ? "Извините, сейчас не получилось обработать файл. Попробуйте отправить его ещё раз чуть позже."
        : "Кешіріңіз, файлды қазір өңдей алмадым. Сәлден соң қайта жіберіп көріңіз.");
      assert.match(result.analysis, /MEDIA_ANALYSIS_INVALID_JSON/);
      assert.match(result.analysis, /\[ESCALATE_DEVELOPER\]/);
      assert.doesNotMatch(JSON.stringify(result), /RAW_PROVIDER_FAILURE/);
      assert.equal(fetch.mock.callCount(), 1);
      assert.equal(errors.mock.callCount(), 1);
      assert.doesNotMatch(JSON.stringify(errors.mock.calls.map((call) => call.arguments)), /RAW_PROVIDER_FAILURE/);
    });
  }
}

test("missing media still returns null without invoking a provider", async (t) => {
  const { fetch } = mockMediaResponse(t, "{}");
  assert.equal(await analyzeMedia("", "image/png"), null);
  assert.equal(fetch.mock.callCount(), 0);
});

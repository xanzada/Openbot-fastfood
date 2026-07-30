import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguageDecision, detectLang, parseGeminiLanguageDecision } from "../src/utils/language.js";
import { detectNameLanguage, resolveOrganicLanguage, shouldSwitchLockedLanguage } from "../src/services/languagePolicy.service.js";

// Kazakh typed without ә ғ қ ң ө ұ ү і is ordinary on a phone keyboard. The
// regex cannot see it, which is why a failed classification must never be
// allowed to lock the language for 24 hours.
const PLAIN_KAZAKH = "Ассалаумагалейкум, пицца бар ма, канша турады";

test("a classifier answer is trusted and is lockable when confident", async () => {
  const decision = await detectLanguageDecision(PLAIN_KAZAKH, async () => '{"language":"kk","confidence":0.92}');
  assert.equal(decision.language, "kk");
  assert.equal(decision.detector, "gemini");
  assert.equal(decision.lockable, true);
});

test("a low-confidence answer is used but never locked", async () => {
  const decision = await detectLanguageDecision(PLAIN_KAZAKH, async () => '{"language":"ru","confidence":0.3}');
  assert.equal(decision.detector, "gemini");
  assert.equal(decision.lockable, false, "an unsure classification must not own the next 24 hours");
});

test("when the classifier fails the fallback answers but is not lockable", async () => {
  const decision = await detectLanguageDecision(PLAIN_KAZAKH, async () => {
    throw new Error("GEMINI_MEDIA_404");
  });
  assert.equal(decision.detector, "fallback");
  assert.equal(decision.lockable, false, "this is exactly the case that locked Kazakh guests into Russian");
  // The fallback itself gets this wrong, which is precisely why it must not lock.
  assert.equal(decision.language, detectLang(PLAIN_KAZAKH));
});

test("the fallback recognises Kazakh typed on a Russian keyboard", () => {
  // Every one of these is ordinary Kazakh written without ә ғ қ ң ө ұ ү і.
  for (const text of [
    "Ассалаумагалейкум, пицца канша",
    "пицца канша турады",
    "жеткизу бар ма",
    "калай тапсырыс беремин",
    "рахмет, болады",
  ]) {
    assert.equal(detectLang(text), "kk", text);
  }
});

test("plain Russian is still read as Russian", () => {
  for (const text of [
    "Добрый день, сколько стоит пицца",
    "Здравствуйте, хочу заказать доставку",
    "А когда будет готов мой заказ",
  ]) {
    assert.equal(detectLang(text), "ru", text);
  }
});

test("a stored language always wins over any detection", () => {
  assert.equal(detectLang("Добрый день", "kk"), "kk");
  assert.equal(detectLang("Сәлеметсіз бе", "ru"), "ru");
});

test("a 24-hour lock switches only after two consecutive messages in the other language", () => {
  assert.equal(shouldSwitchLockedLanguage("kk", null, "ru"), false);
  assert.equal(shouldSwitchLockedLanguage("kk", "kk", "ru"), false);
  assert.equal(shouldSwitchLockedLanguage("kk", "ru", "ru"), true);
  assert.equal(shouldSwitchLockedLanguage("ru", "kk", "kk"), true);
});

test("a malformed classifier reply is rejected rather than half-read", () => {
  assert.equal(parseGeminiLanguageDecision('{"language":"de","confidence":1}'), null);
  assert.equal(parseGeminiLanguageDecision("not json at all"), null);
  assert.deepEqual(parseGeminiLanguageDecision('```json\n{"language":"kk","confidence":0.8}\n```'), {
    language: "kk",
    confidence: 0.8,
  });
});

// A guest who never came through the site has no saved language. Their turn is
// resolved again every time, so the language question can never get stuck.
test("a contact name decides the language when the message carries no signal", () => {
  assert.equal(detectNameLanguage("Айгүл"), "kk");
  assert.equal(detectNameLanguage("Нурбек"), "kk");
  assert.equal(detectNameLanguage("Александр"), "ru");
  assert.equal(detectNameLanguage("Иванов"), "ru");
  assert.equal(detectNameLanguage("+7 747"), null);
});

test("what the guest just wrote outranks their name and their history", () => {
  const resolved = resolveOrganicLanguage({
    detected: "ru",
    priorLanguage: "kk",
    contactName: "Айгүл",
    siteLanguageHint: "kk",
  });
  assert.equal(resolved.language, "ru");
  assert.equal(resolved.source, "message");
});

test("a returning guest keeps their usual language when a turn says nothing", () => {
  const resolved = resolveOrganicLanguage({
    detected: null,
    priorLanguage: "ru",
    contactName: "Айгүл",
    siteLanguageHint: "kk",
  });
  assert.equal(resolved.language, "ru");
  assert.equal(resolved.source, "history");
});

test("a brand new guest falls back to the name, then the site, then Kazakh", () => {
  assert.deepEqual(
    resolveOrganicLanguage({ detected: null, priorLanguage: null, contactName: "Сергей", siteLanguageHint: "kk" }),
    { language: "ru", source: "contact_name" }
  );
  assert.deepEqual(
    resolveOrganicLanguage({ detected: null, priorLanguage: null, contactName: "", siteLanguageHint: "ru" }),
    { language: "ru", source: "site_hint" }
  );
  assert.deepEqual(
    resolveOrganicLanguage({ detected: null, priorLanguage: null, contactName: "", siteLanguageHint: null }),
    { language: "kk", source: "default" }
  );
});

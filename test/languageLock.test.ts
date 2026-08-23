import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguageDecision, detectLang, isLanguageBearingCustomerText, lastCustomerLanguage, parseGeminiLanguageDecision } from "../src/utils/language.js";
import { detectNameLanguage, resolveOrganicLanguage, shouldSwitchLockedLanguage, textCarriesDecisiveLanguageSignal } from "../src/services/languagePolicy.service.js";

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

test("what the guest just wrote outranks their name and the site hint", () => {
  // A contact name and a site hint are guesses about a person; the message in front of us
  // is evidence. That ordering is unchanged.
  const resolved = resolveOrganicLanguage({
    detected: "ru",
    priorLanguage: null,
    contactName: "Айгүл",
    siteLanguageHint: "kk",
  });
  assert.equal(resolved.language, "ru");
  assert.equal(resolved.source, "message");
});

test("but it does not outrank the dialogue unless it is unmistakable", () => {
  // This test used to assert the opposite, and that was the defect: a weak "ru" reading
  // of one short turn flipped a Kazakh conversation to Russian. Reported by the owner and
  // reproduced 2026-08-23 - a guest who answered "ok" was answered in Russian.
  const weak = resolveOrganicLanguage({
    detected: "ru",
    priorLanguage: "kk",
    contactName: "Айгүл",
    siteLanguageHint: "kk",
    detectedIsDecisive: false,
  });
  assert.equal(weak.language, "kk");
  assert.equal(weak.source, "history");

  // A genuine switch is still immediate - restraint must not turn into stubbornness.
  const decisive = resolveOrganicLanguage({
    detected: "ru",
    priorLanguage: "kk",
    contactName: "Айгүл",
    siteLanguageHint: "kk",
    detectedIsDecisive: true,
  });
  assert.equal(decisive.language, "ru");
  assert.equal(decisive.source, "message");
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

test("an unmistakable message switches the locked language at once", () => {
  // "тамақтың сапасы нашар" carries Kazakh-only letters, so answering it in
  // Russian and waiting for a second Kazakh message insults the guest.
  assert.equal(textCarriesDecisiveLanguageSignal("тамақтың сапасы нашар", "kk"), true);
  assert.equal(shouldSwitchLockedLanguage("ru", "ru", "kk", true), true);
  assert.equal(textCarriesDecisiveLanguageSignal("здравствуйте, сколько стоит доставка", "ru"), true);
  assert.equal(shouldSwitchLockedLanguage("kk", "kk", "ru", true), true);
});

test("a weak signal still needs a second message before the lock moves", () => {
  assert.equal(textCarriesDecisiveLanguageSignal("ok", "kk"), false);
  assert.equal(textCarriesDecisiveLanguageSignal("бар ма", "ru"), false);
  assert.equal(shouldSwitchLockedLanguage("ru", "ru", "kk", false), false);
  assert.equal(shouldSwitchLockedLanguage("ru", "kk", "kk", false), true);
  assert.equal(shouldSwitchLockedLanguage("kk", "ru", "kk", true), false);
});

// Live round 2026-08-12: after several Russian turns a bare "👍👍👍" was answered
// in Kazakh, because the only entry consulted was the previous customer message
// and that one carried no language signal either.
test("a signal-free message keeps the language the guest last actually used", () => {
  const history = [
    { role: "user", text: "Здравствуйте, что есть из суши?" },
    { role: "assistant", text: "Есть роллы..." },
    { role: "user", text: "ок" },
    { role: "assistant", text: "Хорошо" },
    { role: "user", text: "👍" },
  ];
  assert.equal(lastCustomerLanguage(history), "ru");
});

test("a Kazakh order intent followed by mhm keeps the conversation in Kazakh", () => {
  assert.equal(detectLang("Заказ берейін"), "kk", "mixed everyday Kazakh must not collapse to Russian");
  assert.equal(isLanguageBearingCustomerText("Мхм"), false, "acknowledgement carries consent, not a language switch");
  assert.equal(lastCustomerLanguage([{ role: "user", text: "Заказ берейін" }]), "kk");
});

test("the scan reads only customer messages and gives up rather than guessing", () => {
  assert.equal(lastCustomerLanguage([{ role: "assistant", text: "Сәлеметсіз бе" }]), null);
  assert.equal(lastCustomerLanguage([]), null);
  assert.equal(lastCustomerLanguage(null), null);
  assert.equal(
    lastCustomerLanguage([{ role: "user", text: "Сәлем, мәзір бар ма?" }, { role: "user", text: "👍" }]),
    "kk",
  );
});

test("a language used long ago stops deciding", () => {
  const history: any[] = [{ role: "user", text: "Здравствуйте, меню есть?" }];
  for (let index = 0; index < 12; index += 1) history.push({ role: "user", text: "👍" });
  assert.equal(lastCustomerLanguage(history), null);
});

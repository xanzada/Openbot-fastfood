import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { detectLanguageDecision } from "../src/utils/language.js";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { redisClient } = await import("../src/services/redis.service.js");
test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

const { isLanguageBearingCustomerText, lastCustomerLanguage, detectLang } = await import("../src/utils/language.js");
const { resolveOrganicLanguage, shouldSwitchLockedLanguage, textCarriesDecisiveLanguageSignal } =
  await import("../src/services/languagePolicy.service.js");
const read = (relative: string) => readFile(new URL(relative, import.meta.url), "utf8");

// Owner report, reproduced 2026-08-23: a guest speaks Kazakh for the whole conversation,
// answers "ok", and the bot answers in Russian. Two independent causes, both about the
// same thing - the bot was reading the token instead of the dialogue.

const kazakhDialogue = [
  { role: "user", text: "Сәлеметсіз бе, пицца бар ма?" },
  { role: "assistant", text: "Бар, 2500 теңге." },
  { role: "user", text: "Жеткізу қанша уақыт?" },
  { role: "assistant", text: "30 минут." },
];

test("a bare acknowledgement carries no language, whichever alphabet it is typed in", () => {
  // The list held the Cyrillic "ок"/"окей" and "okay" but not the plain Latin "ok" - which
  // is what people actually type. Every detector calls a Latin word Russian, so that one
  // token reclassified the whole conversation.
  for (const token of ["ok", "OK", "Ok", "ok!", "okay", "okey", "k", "ок", "окей", "ок.", "+", "++", "👍", "мхм", "угу", "ага", "12"]) {
    assert.equal(
      isLanguageBearingCustomerText(token),
      false,
      `${JSON.stringify(token)} is an acknowledgement, not a language choice`
    );
  }
});

test("a real word still carries language, in both directions", () => {
  // The neutral list must stay narrow: widening it until "жақсы" or "хорошо" stops
  // counting would break genuine switching.
  for (const [token, expected] of [
    ["жақсы", "kk"],
    ["жарайды", "kk"],
    ["рахмет", "kk"],
    ["жоқ", "kk"],
    ["хорошо", "ru"],
    ["спасибо", "ru"],
    ["нет", "ru"],
    ["да", "ru"],
  ] as [string, string][]) {
    assert.equal(isLanguageBearingCustomerText(token), true, `${token} must still be read`);
    assert.equal(detectLang(token), expected, `${token} must fall back to ${expected}`);
  }
});

test("the offline fallback knows the Kazakh consent words typed without special letters", () => {
  // "жарайды" on a Russian keyboard has no ә ғ қ ң ө ұ ү і, and the fallback used to call
  // anything without those letters Russian.
  for (const token of ["жарайды", "жарайд", "макул", "мақұл"]) {
    assert.equal(detectLang(token), "kk", `${token} is Kazakh`);
  }
});

test("an acknowledgement does not become the language of the conversation", () => {
  // lastCustomerLanguage walks back past signal-free turns; "ok" was not signal-free, so
  // the walk stopped on it and answered "ru".
  const history = [...kazakhDialogue, { role: "user", text: "ok" }];
  assert.equal(lastCustomerLanguage(history), "kk");
  assert.equal(lastCustomerLanguage([...kazakhDialogue, { role: "user", text: "👍" }]), "kk");
  assert.equal(lastCustomerLanguage([...kazakhDialogue, { role: "user", text: "+" }]), "kk");
});

test("a weak detection does not overturn an established dialogue", () => {
  // This is the defect in one line: resolveOrganicLanguage returned `detected`
  // unconditionally, so one weak guess outranked ten Kazakh messages. The locked path has
  // required confirmation since 2026-08-12; the organic path - every WhatsApp-native
  // guest - never got the same restraint.
  const weak = resolveOrganicLanguage({ detected: "ru", priorLanguage: "kk", detectedIsDecisive: false });
  assert.equal(weak.language, "kk");
  assert.equal(weak.source, "history");
});

test("an unmistakable message switches the language at once", () => {
  // Restraint must not become stubbornness: a guest who genuinely switches is answered in
  // the new language on the same turn, not the next one.
  const decisive = resolveOrganicLanguage({ detected: "ru", priorLanguage: "kk", detectedIsDecisive: true });
  assert.equal(decisive.language, "ru");
  assert.equal(decisive.source, "message");

  // And the decisiveness test is the shared one, so both lanes agree on what counts.
  assert.equal(textCarriesDecisiveLanguageSignal("Здравствуйте, сколько стоит доставка?", "ru"), true);
  assert.equal(textCarriesDecisiveLanguageSignal("Сәлеметсіз бе", "kk"), true);
  assert.equal(textCarriesDecisiveLanguageSignal("ok", "ru"), false);
});

test("a detection that agrees with the dialogue is used directly", () => {
  const agreeing = resolveOrganicLanguage({ detected: "kk", priorLanguage: "kk", detectedIsDecisive: false });
  assert.equal(agreeing.source, "message");
  assert.equal(agreeing.language, "kk");
});

test("a first-time guest is unaffected, since there is no dialogue to contradict", () => {
  const fresh = resolveOrganicLanguage({ detected: "ru", priorLanguage: null, detectedIsDecisive: false });
  assert.equal(fresh.language, "ru");
  assert.equal(fresh.source, "message");
  // The remaining ladder is untouched: name, then site hint, then Kazakh.
  assert.equal(resolveOrganicLanguage({ detected: null, priorLanguage: null, contactName: "Айгүл" }).source, "contact_name");
  assert.equal(resolveOrganicLanguage({ detected: null, priorLanguage: null, siteLanguageHint: "ru" }).source, "site_hint");
  assert.equal(resolveOrganicLanguage({ detected: null, priorLanguage: null }).language, "kk");
});

test("the locked path keeps its own inertia, unchanged", () => {
  assert.equal(shouldSwitchLockedLanguage("kk", "kk", "ru", false), false);
  assert.equal(shouldSwitchLockedLanguage("kk", "ru", "ru", false), true);
  assert.equal(shouldSwitchLockedLanguage("kk", "kk", "ru", true), true);
  assert.equal(shouldSwitchLockedLanguage("kk", null, "kk", false), false);
});

test("both lanes measure decisiveness with the same function", async () => {
  const preload = await read("../src/context/preloadContext.ts");
  // If the organic lane invented its own notion of "decisive", the two lanes would drift
  // and the same message would switch one and not the other.
  assert.match(preload, /detectedIsDecisive: Boolean\(/);
  assert.match(preload, /textCarriesDecisiveLanguageSignal\(languageCandidateText, decision\.language\)/);
});

// The classifier now sees the CONVERSATION, not one bare turn. "ащы ма" carries
// no Kazakh-specific letter, so alone it was classified Russian and a Kazakh
// dialogue got a Russian answer (owner report, 2026-08-24).
test("a short Kazakh follow-up is classified with the conversation, not alone", async () => {
  const prompts: string[] = [];
  const classifier = async (request: any) => {
    prompts.push(String(request?.prompt || ""));
    return JSON.stringify({ language: "kk", confidence: 0.9 });
  };

  const decision = await detectLanguageDecision("ащы ма", classifier, [
    "анау тауықтысы барма",
    "қанша тұрады",
  ]);

  assert.equal(decision.language, "kk");
  assert.equal(decision.detector, "gemini");
  assert.ok(prompts[0].includes("Earlier messages from the SAME customer"), "context must reach the classifier");
  assert.ok(prompts[0].includes("анау тауықтысы барма"), "the earlier Kazakh turn travels with the request");
  assert.ok(prompts[0].includes("ащы ма"), "the newest message is still the one being judged");
});

test("with no history the classifier is still asked about the single message", async () => {
  const prompts: string[] = [];
  const classifier = async (request: any) => {
    prompts.push(String(request?.prompt || ""));
    return JSON.stringify({ language: "ru", confidence: 0.8 });
  };

  const decision = await detectLanguageDecision("здравствуйте, сколько стоит доставка", classifier);

  assert.equal(decision.language, "ru");
  assert.ok(!prompts[0].includes("Earlier messages"), "no phantom context when there is none");
});

// The "prior" language of a dialogue is derived by a REGEX that calls any text
// without ә ғ қ ң ө ұ ү і Russian. A Kazakh conversation typed in ordinary words
// therefore produced prior=ru, which outvoted a Gemini verdict of kk/1.0 and the
// guest was answered in Russian (owner report, reproduced from the
// [OPENBOT:LANG] line, 2026-08-24). A confident classifier must win.
test("a confident classification outranks a regex-derived dialogue language", () => {
  const confident = resolveOrganicLanguage({
    detected: "kk",
    detectedIsDecisive: true, // preloadContext sets this for confidence >= 0.8
    priorLanguage: "ru",
  });
  assert.equal(confident.language, "kk");
  assert.equal(confident.source, "message");
});

test("a weak classification still yields to the established dialogue", () => {
  const weak = resolveOrganicLanguage({
    detected: "ru",
    detectedIsDecisive: false,
    priorLanguage: "kk",
  });
  assert.equal(weak.language, "kk", "one weak token must not flip a Kazakh dialogue");
  assert.equal(weak.source, "history");
});

test("preloadContext treats high classifier confidence as decisive", async () => {
  const src = await readFile(new URL("../src/context/preloadContext.ts", import.meta.url), "utf8");
  assert.match(src, /\(decision\.confidence \?\? 0\) >= 0\.8/, "the confidence override must stay in the organic lane");
});

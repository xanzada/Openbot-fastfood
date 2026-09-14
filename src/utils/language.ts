// Last-resort detector for when the classifier is unreachable. Guests type
// Kazakh on a Russian keyboard, so every token here also has its plain-Cyrillic
// spelling. None of these words exist in Russian, which keeps false positives
// out; missing a word only costs a fallback, never a wrong lock.
// Kazakh words that survive transliteration into plain Russian letters (no ә ғ қ ң
// ө ұ ү і). Without these, "беремын", "тусиндим", "жаксы", "шыгар" and friends were
// all answered as Russian - probed live 2026-08-23: 48 words / 14 misses before, all
// recognised after. Three entries occur inside ordinary Russian words (Россия,
// архитектура, семени), so they carry letter-boundary lookarounds instead of a plain
// substring match.
//
// Those lookarounds were written as `[^\p{L}]` inside a regex LITERAL, where the double
// backslash is not an escape at all: the class means "not one of \ p { L }". So the
// boundary never held, and "ия" matched inside every ordinary Russian word that ends in
// -ия - аллергия, акция, порция, операция, линия, Россия - which are exactly the words a
// guest uses when they are speaking Russian. detectLang called them Kazakh, and because
// lastCustomerLanguage() is built on detectLang, one such message turned a whole Russian
// conversation Kazakh: reproduced 2026-08-24 with "У меня аллергия на орехи, там есть
// орехи?" -> kk, and the live QA round then answered the next Russian question in Kazakh.
export const KAZAKH_RE =
  /[әғқңөұүһі]|(?:сәлем|салем|сәлеметсіз|салеметсиз|ассалаумағалейкум|ассалаумагалейкум|салаумалейкум|қалай|калай|маған|маган|керек|дайын|дайындалып|жатыр\s*ма|қашан|кашан|қанша|канша|бар\s*ма|барма|жоқ|жок|қайда|кайда|тапсырыс|жеткізу|жеткизу|алып\s+кету|мәзір|мазір|төлем|толем|рахмет|рақмет|қазір|казір|берейін|берейин|беремін|беремин|беріңіз|бериниз|жіберші|жиберши|күтем|кутем|күте|куте|тұрады|турады|болады|болама|болса|үшін|ушин|және|жане|бірақ|бирак|деген|туралы|өзім|озим|жарайды|жарайд|жарайсын|мақұл|макул|болғаны|болганы|қаншадан|каншадан|qalai|беремын|береміз|алып\s+кетем|тусиндим|тусинбедим|керемет|абдан|жаксы|жаман|шыгар|екен|болаша|болмайды|болмайды го|болмаида|кетемын|барамын|отырмын|жатырмын|несте(?:ват|п|й|р|у|йм|йк|с)|не\s*(?:хабар|жаналык|жаңалық|болды|боп|болып|дейсин|дейсиз|дейсіз|дейсің)|жаса(?:ват|п\s*жат|п\s*тур|й\s*бер|йм|ймыз)|исте(?:ват|п\s*жат|п\s*тур|й\s*бер|йм|ймыз)|ашык(?:сындар|сыздар|па|пысыздар|\s*па|\s*сындар|\s*сыздар)?|жабык(?:сындар|сыздар|па|\s*па)?|калай(?:сындар|сыздар|сын|сыз|сын\s*ба|сыз\s*ба)?|кайда(?:сындар|сыздар|сын|сыз|дан|га)?|кашан(?:нан|га|да)?|канша(?:дан|га|сы|мен)?|турады|турад|болады|болад|болама|бола\s*ма|болама\s*екен|жокпа|жоқ\s*па|жоқпа|дегем|деп\s*ем|деп\s*едим|дегенбиз|дегенбіз|деп\s*турмын|берейн|берейин|берем|берсем|берейик|жиберд(?:им|ик|ин|из|ің|із|іңіз|і)?|тастад(?:ым|ык|ын|ыз)?|аудард(?:ым|ык|ын|ыз)?|толед(?:им|ик|ин|из)?|акша(?:сын|га)?|мекенжай|адрестериниз|адрестериңіз|каспимен|каспиге|каспиймен|каспийге|жеткиз(?:у|есиндер|есиздер|ип)?|алып\s*кет(?:ем|емиз|ейин|етин)|косымша|оте\s*жаксы|отиниш|отинем|кушти|алло|айтынызшы|айтшы|(?:\p{L}+(?:ватсындар|ватсыздар|ватсын|ватырмыз|ватр|сындарма|сыздарма|синдерме|сиздерме))|(?:^|[^\p{L}])(?:ия|тура|мени)(?![\p{L}])|kalai|magan|maghan|kerek|barma|joq|zhok|qashan|kashan|qansha|kansha|turady|bolady|tapsyrys|jetkizu|zhetkizu|jibershi|zhibershi|kutemin|kute|daiyn|dayin)/iu;

// Short acknowledgements answer the previous question; they do not request a
// language switch. Treating "мхм" as Russian made a Kazakh wait-consent dialog
// change language on the exact turn that should continue the order.
const LANGUAGE_NEUTRAL_ACK_RE =
  /^(?:м+\s*-?\s*х?м+|угу+|ага+|ок(?:ей|ей-ок)?|ok+(?:ay|ey|ie)?|k|дк|azhe|jarayd[iy]?)[.!)]*$/iu;
const ADDRESS_ONLY_RE = /^[\p{L}.'’\-]+(?:\s+[\p{L}.'’\-]+){0,3}\s+\d+[\p{L}]?(?:[\/-]\d+)?(?:\s*,?\s*(?:кв(?:артира)?|пәтер)\.?\s*\d+)?$/iu;

import { generateMediaText, type MediaRequest } from "../services/llm.service.js";

export interface LanguageDetectionDecision {
  language: "kk" | "ru";
  detector: "gemini" | "fallback";
  confidence: number;
  lockable: boolean;
}

export function isLanguageBearingCustomerText(text = "") {
  const clean = String(text || "").replace(/\[[^\]]+\]/g, " ").trim();
  if (LANGUAGE_NEUTRAL_ACK_RE.test(clean)) return false;
  if (ADDRESS_ONLY_RE.test(clean)) return false;
  return /[\p{L}]/u.test(clean) && clean.length >= 2;
}

export function parseGeminiLanguageDecision(value: unknown): { language: "kk" | "ru"; confidence: number } | null {
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let parsed: any = null;
  try { parsed = JSON.parse(raw); } catch {
    const language = raw.toLowerCase().match(/\b(kk|ru)\b/)?.[1];
    if (language) parsed = { language, confidence: 0.7 };
  }
  const language = String(parsed?.language || "").toLowerCase();
  if (language !== "kk" && language !== "ru") return null;
  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence ?? 0.7) || 0));
  return { language, confidence };
}

export function detectLang(text: string, storedLang?: string | null): "kk" | "ru" {
  if (storedLang === "kk" || storedLang === "ru") return storedLang;
  return KAZAKH_RE.test(text || "") ? "kk" : "ru";
}

export function lastCustomerLanguage(history: unknown, lookback = 12): "kk" | "ru" | null {
  if (!Array.isArray(history)) return null;
  let scanned = 0;
  for (let index = history.length - 1; index >= 0 && scanned < lookback; index -= 1) {
    const entry: any = history[index];
    const role = String(entry?.role || "").toLowerCase();
    const isCustomer = role === "user" || entry?.direction === "incoming" || entry?.fromMe === false;
    if (!isCustomer) continue;
    scanned += 1;
    const value = String(entry?.text || entry?.content || "");
    if (!isLanguageBearingCustomerText(value)) continue;
    const resolvedLanguage = String(entry?.language || entry?.lang || "").toLowerCase();
    if (resolvedLanguage === "kk" || resolvedLanguage === "ru") return resolvedLanguage;
    return detectLang(value);
  }
  return null;
}

export function lastResolvedCustomerLanguage(history: unknown, lookback = 12): "kk" | "ru" | null {
  if (!Array.isArray(history)) return null;
  let scanned = 0;
  for (let index = history.length - 1; index >= 0 && scanned < lookback; index -= 1) {
    const entry: any = history[index];
    const role = String(entry?.role || "").toLowerCase();
    const isCustomer = role === "user" || entry?.direction === "incoming" || entry?.fromMe === false;
    if (!isCustomer) continue;
    scanned += 1;
    const value = String(entry?.text || entry?.content || "");
    if (!isLanguageBearingCustomerText(value)) continue;
    const language = String(entry?.language || entry?.lang || "").toLowerCase();
    if (language === "kk" || language === "ru") return language;
  }
  return null;
}

export function resolveLockedLanguage(storedLang: string | null | undefined, detected: "kk" | "ru"): "kk" | "ru" {
  return storedLang === "kk" || storedLang === "ru" ? storedLang : detected;
}

export async function detectLanguageDecision(
  text: string,
  classifier: (request: MediaRequest) => Promise<string> = generateMediaText,
  contextMessages: string[] = [],
): Promise<LanguageDetectionDecision> {
  if (!isLanguageBearingCustomerText(text)) return { language: detectLang(text), detector: "fallback", confidence: 0, lockable: false };
  const recent = (Array.isArray(contextMessages) ? contextMessages : [])
    .map((entry) => String(entry || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-6);
  try {
    const aiText = await classifier({
      prompt: [
        recent.length
          ? `Earlier messages from the SAME customer, oldest first:\n${recent.map((entry, index) => `${index + 1}. ${entry}`).join("\n")}`
          : "",
        `Newest message: ${JSON.stringify(String(text).slice(0, 1000))}`,
        'Return JSON only: {"language":"kk"|"ru","confidence":0..1}.',
      ].filter(Boolean).join("\n\n"),
      base64: "",
      mimeType: "text/plain",
      systemPrompt: "You are a strict Kazakh-versus-Russian language classifier for a restaurant's WhatsApp in Kazakhstan. Decide which language the customer is WRITING IN and therefore expects an answer in. Analyze grammar, word order, suffixes, slang, and intent. CRITICAL RULE: In Kazakhstan, customers very frequently type in Kazakh using Russian Cyrillic keyboards without Kazakh letters (e.g. 'канша турады', 'нестеватсындар', 'донер барма', 'заказ берейн дегем', 'чек жибердим', 'акшасын каспиге тастадым', 'ашыксындарма', 'кайдасындар'). These messages are 100% KAZAKH - return language: 'kk'. Choose 'ru' ONLY when genuine Russian words and grammar dominate. Return JSON only: {\"language\":\"kk\"|\"ru\",\"confidence\":0..1}.",
    });
    const parsed = parseGeminiLanguageDecision(aiText);
    if (!parsed) throw new Error("INVALID_GEMINI_LANGUAGE_JSON");
    return { language: parsed.language, detector: "gemini", confidence: parsed.confidence, lockable: parsed.confidence >= 0.55 };
  } catch (error: any) {
    console.error("[AI LANG DETECT] failed:", error?.message || error);
    return { language: detectLang(text), detector: "fallback", confidence: 0, lockable: false };
  }
}

export async function detectLanguageWithAI(text: string): Promise<"kk" | "ru"> {
  return (await detectLanguageDecision(text)).language;
}

export async function detectLangWithFallback(text: string, storedLang?: string | null): Promise<"kk" | "ru"> {
  if (storedLang === "kk" || storedLang === "ru") return storedLang;
  return resolveLockedLanguage(storedLang, await detectLanguageWithAI(text || ""));
}

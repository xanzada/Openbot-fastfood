// Last-resort detector for when the classifier is unreachable. Guests type
// Kazakh on a Russian keyboard, so every token here also has its plain-Cyrillic
// spelling. None of these words exist in Russian, which keeps false positives
// out; missing a word only costs a fallback, never a wrong lock.
const KAZAKH_RE =
  /[әғқңөұүһі]|(?:сәлем|салем|сәлеметсіз|салеметсиз|ассалаумағалейкум|ассалаумагалейкум|салаумалейкум|қалай|калай|маған|маган|керек|дайын|дайындалып|жатыр\s*ма|қашан|кашан|қанша|канша|бар\s*ма|жоқ|жок|қайда|кайда|тапсырыс|жеткізу|жеткизу|алып\s+кету|мәзір|мазір|төлем|толем|рахмет|рақмет|қазір|казір|беріңіз|бериниз|жіберші|жиберши|күтем|кутем|күте|куте|тұрады|турады|болады|болама|болса|үшін|ушин|және|жане|бірақ|бирак|деген|туралы|өзім|озим|qalai|kalai|magan|maghan|kerek|barma|joq|zhok|qashan|kashan|qansha|kansha|turady|bolady|tapsyrys|jetkizu|zhetkizu|jibershi|zhibershi|kutemin|kute|daiyn|dayin)/iu;

// generateMediaText, not callGemini: the language of the whole 24-hour lock must
// not hang on one provider. callGemini alone has no reserve, so while the free
// keys answered 404 every detection fell through to the regex below, which calls
// anything without Kazakh letters Russian.
import { generateMediaText, type MediaRequest } from "../services/llm.service.js";

export interface LanguageDetectionDecision {
  language: "kk" | "ru";
  detector: "gemini" | "fallback";
  confidence: number;
  lockable: boolean;
}

export function isLanguageBearingCustomerText(text = "") {
  const clean = String(text || "").replace(/\[[^\]]+\]/g, " ").trim();
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

// "👍👍👍" after a Russian dialogue was answered in Kazakh: the caller looked at
// the single previous customer entry, and when that one carried no language
// signal either ("ок", a number, an emoji) the whole history was discarded and
// the default won. The language of a conversation is the last language the guest
// actually used, so the scan walks back until it finds one (live round,
// 2026-08-12).
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
    return detectLang(value);
  }
  return null;
}

export function resolveLockedLanguage(storedLang: string | null | undefined, detected: "kk" | "ru"): "kk" | "ru" {
  return storedLang === "kk" || storedLang === "ru" ? storedLang : detected;
}

export async function detectLanguageDecision(text: string, classifier: (request: MediaRequest) => Promise<string> = generateMediaText): Promise<LanguageDetectionDecision> {
  if (!isLanguageBearingCustomerText(text)) return { language: detectLang(text), detector: "fallback", confidence: 0, lockable: false };
  try {
    const aiText = await classifier({
      prompt: `Determine the intended language of this WhatsApp customer message. Return JSON only: {"language":"kk"|"ru","confidence":0..1}. Message: ${JSON.stringify(String(text).slice(0, 1000))}`,
      base64: "",
      mimeType: "text/plain",
      systemPrompt: "You are a strict Kazakh-versus-Russian language classifier. Analyze grammar, word order, suffixes, slang, and intent. Kazakh may be misspelled, transliterated, typed without ә ғ қ ң ө ұ ү і, or mixed with Russian loanwords. Do not rely only on special Kazakh letters. Choose ru only when Russian grammar and vocabulary dominate. Return JSON only.",
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

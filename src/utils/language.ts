const KAZAKH_RE =
  /[әғқңөұүһі]|(?:сәлем|салем|қалай|калай|маған|маган|керек|дайын|дайындалып|жатыр\s*ма|қашан|кашан|бар\s*ма|жоқ|жок|қайда|кайда|тапсырыс|жеткізу|жеткизу|алып\s+кету|мәзір|мазір|төлем|толем|рахмет|қазір|казір|беріңіз|бериниз|жіберші|жиберши|күтем|кутем|күте|куте|qalai|kalai|magan|maghan|kerek|barma|joq|zhok|qashan|kashan|tapsyrys|jetkizu|zhetkizu|jibershi|zhibershi|kutemin|kute|daiyn|dayin)/iu;

import { callGemini, type MediaRequest } from "../services/llm.service.js";

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

export function resolveLockedLanguage(storedLang: string | null | undefined, detected: "kk" | "ru"): "kk" | "ru" {
  return storedLang === "kk" || storedLang === "ru" ? storedLang : detected;
}

export async function detectLanguageDecision(text: string, classifier: (request: MediaRequest) => Promise<string> = callGemini): Promise<LanguageDetectionDecision> {
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

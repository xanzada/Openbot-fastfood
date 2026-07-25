const KAZAKH_RE = /[әғқңөұүһі]|(?:сәлем|салем|қалай|калай|маған|маган|керек|дайын|дайындалып|жатыр\s*ма|қашан|кашан|бар\s*ма|жоқ|жок|қайда|кайда|тапсырыс|жеткізу|жеткизу|алып\s+кету|мәзір|мазір|төлем|толем|рахмет|қазір|казір|беріңіз|бериниз|жіберші|жиберши|күтем|кутем|күте|куте|qalai|kalai|magan|maghan|kerek|barma|joq|zhok|qashan|kashan|tapsyrys|jetkizu|zhetkizu|jibershi|zhibershi|kutemin|kute|daiyn|dayin)/iu;
import { callGemini } from "../services/llm.service.js";
function isLanguageBearingCustomerText(text = "") {
  const clean = String(text || "").replace(/\[[^\]]+\]/g, " ").trim();
  return /[\p{L}]/u.test(clean) && clean.length >= 2;
}
function parseGeminiLanguageDecision(value) {
  const raw = String(value || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    const language2 = raw.toLowerCase().match(/\b(kk|ru)\b/)?.[1];
    if (language2) parsed = { language: language2, confidence: 0.7 };
  }
  const language = String(parsed?.language || "").toLowerCase();
  if (language !== "kk" && language !== "ru") return null;
  const confidence = Math.max(0, Math.min(1, Number(parsed?.confidence ?? 0.7) || 0));
  return { language, confidence };
}
function detectLang(text, storedLang) {
  if (storedLang === "kk" || storedLang === "ru") return storedLang;
  return KAZAKH_RE.test(text || "") ? "kk" : "ru";
}
function resolveLockedLanguage(storedLang, detected) {
  return storedLang === "kk" || storedLang === "ru" ? storedLang : detected;
}
async function detectLanguageDecision(text, classifier = callGemini) {
  if (!isLanguageBearingCustomerText(text)) return { language: detectLang(text), detector: "fallback", confidence: 0, lockable: false };
  try {
    const aiText = await classifier({
      prompt: `Determine the intended language of this WhatsApp customer message. Return JSON only: {"language":"kk"|"ru","confidence":0..1}. Message: ${JSON.stringify(String(text).slice(0, 1e3))}`,
      base64: "",
      mimeType: "text/plain",
      systemPrompt: "You are a strict Kazakh-versus-Russian language classifier. Analyze grammar, word order, suffixes, slang, and intent. Kazakh may be misspelled, transliterated, typed without \u04D9 \u0493 \u049B \u04A3 \u04E9 \u04B1 \u04AF \u0456, or mixed with Russian loanwords. Do not rely only on special Kazakh letters. Choose ru only when Russian grammar and vocabulary dominate. Return JSON only."
    });
    const parsed = parseGeminiLanguageDecision(aiText);
    if (!parsed) throw new Error("INVALID_GEMINI_LANGUAGE_JSON");
    return { language: parsed.language, detector: "gemini", confidence: parsed.confidence, lockable: parsed.confidence >= 0.55 };
  } catch (error) {
    console.error("[AI LANG DETECT] failed:", error?.message || error);
    return { language: detectLang(text), detector: "fallback", confidence: 0, lockable: false };
  }
}
async function detectLanguageWithAI(text) {
  return (await detectLanguageDecision(text)).language;
}
async function detectLangWithFallback(text, storedLang) {
  if (storedLang === "kk" || storedLang === "ru") return storedLang;
  return resolveLockedLanguage(storedLang, await detectLanguageWithAI(text || ""));
}
export {
  detectLang,
  detectLangWithFallback,
  detectLanguageDecision,
  detectLanguageWithAI,
  isLanguageBearingCustomerText,
  parseGeminiLanguageDecision,
  resolveLockedLanguage
};

const KAZAKH_RE =
  /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]|(сәлем|салем|қалай|калай|дайындалып|жатырма|жатыр\s*ма|қашан|кашан|барма|бар\s*ма|жоқпа|жокпа|жоқ\s*па|жок\s*па|керек|қайда|кайда|тапсырыс|жеткізу|жеткизу|алып кету|мәзір|меню|реквизит|төлем|рахмет|қазір|казір|беріңіз|жіберші)|[У™Т“Т›ТЈУ©Т±ТЇТ»С–]|(СЃУ™Р»РµРј|Т›Р°Р»Р°Р№|РґР°Р№С‹РЅРґР°Р»С‹Рї|Р¶Р°С‚С‹СЂРјР°|Т›Р°С€Р°РЅ|Р±Р°СЂРјР°|Р¶РѕТ›РїР°|Р¶РѕРєРїР°|РєРµСЂРµРє|Т›Р°Р№РґР°|С‚Р°РїСЃС‹СЂС‹СЃ|Р¶РµС‚РєС–Р·Сѓ|Р°Р»С‹Рї РєРµС‚Сѓ|РјУ™Р·С–СЂ|РјРµРЅСЋ|СЂРµРєРІРёР·РёС‚|С‚У©Р»РµРј)/iu;

import { generateMediaText } from "../services/llm.service.js";

export function detectLang(text: string, storedLang?: string | null): "kk" | "ru" {
  if (storedLang === "kk" || storedLang === "ru") return storedLang;
  return KAZAKH_RE.test(text || "") ? "kk" : "ru";
}

export function resolveLockedLanguage(storedLang: string | null | undefined, detected: "kk" | "ru"): "kk" | "ru" {
  return storedLang === "kk" || storedLang === "ru" ? storedLang : detected;
}

export async function detectLanguageWithAI(text: string): Promise<"kk" | "ru"> {
  try {
    if (!text || text.length < 2) return detectLang(text);
    const aiText = await generateMediaText({
      prompt: `Classify this customer message. Return JSON only: {"language":"kk"} or {"language":"ru"}. Message: ${JSON.stringify(String(text).slice(0, 1000))}`,
      base64: "",
      mimeType: "text/plain",
      systemPrompt:
        "You are a strict Kazakh/Russian language classifier. Use ru only for clearly Russian text; use kk for Kazakh, mixed Kazakh/Russian, transliterated Kazakh, slang, or unclear text.",
    });
    const code = String(aiText).toLowerCase().match(/\b(ru|kk)\b/)?.[1];

    return code === "ru" ? "ru" : "kk";
  } catch (error: any) {
    console.error("[AI LANG DETECT] failed:", error?.message || error);
    return detectLang(text);
  }
}

export async function detectLangWithFallback(text: string, storedLang?: string | null): Promise<"kk" | "ru"> {
  if (storedLang === "kk" || storedLang === "ru") return storedLang;
  return resolveLockedLanguage(storedLang, await detectLanguageWithAI(text || ""));
}

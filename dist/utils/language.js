const KAZAKH_RE = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]|(сәлем|салем|қалай|калай|дайындалып|жатырма|жатыр\s*ма|қашан|кашан|барма|бар\s*ма|жоқпа|жокпа|жоқ\s*па|жок\s*па|керек|қайда|кайда|тапсырыс|жеткізу|жеткизу|алып кету|мәзір|меню|реквизит|төлем|рахмет|қазір|казір|беріңіз|жіберші)|[У™Т“Т›ТЈУ©Т±ТЇТ»С–]|(СЃУ™Р»РµРј|Т›Р°Р»Р°Р№|РґР°Р№С‹РЅРґР°Р»С‹Рї|Р¶Р°С‚С‹СЂРјР°|Т›Р°С€Р°РЅ|Р±Р°СЂРјР°|Р¶РѕТ›РїР°|Р¶РѕРєРїР°|РєРµСЂРµРє|Т›Р°Р№РґР°|С‚Р°РїСЃС‹СЂС‹СЃ|Р¶РµС‚РєС–Р·Сѓ|Р°Р»С‹Рї РєРµС‚Сѓ|РјУ™Р·С–СЂ|РјРµРЅСЋ|СЂРµРєРІРёР·РёС‚|С‚У©Р»РµРј)/iu;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
export function detectLang(text, storedLang) {
    if (storedLang === "kk" || storedLang === "ru")
        return storedLang;
    return KAZAKH_RE.test(text || "") ? "kk" : "ru";
}
async function fetchWithTimeout(url, options = {}, ms = 20000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
export async function detectLanguageWithAI(text) {
    try {
        if (!text || text.length < 2)
            return "kk";
        if (!OPENROUTER_API_KEY) {
            console.warn("[AI LANG DETECT] OPENROUTER_API_KEY is not configured, kk fallback returned.");
            return "kk";
        }
        const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: "openai/gpt-4o-mini",
                temperature: 0,
                max_tokens: 3,
                messages: [
                    {
                        role: "system",
                        content: [
                            "You are a strict language classifier for a Kazakh/Russian restaurant chatbot.",
                            "Return exactly one of two lowercase codes: ru or kk.",
                            "Return ru only when the customer message is clearly Russian.",
                            "Return kk for Kazakh, mixed Kazakh/Russian, Kazakh written with Russian letters, slang, unclear text, greetings, or anything else.",
                            "Do not return punctuation, explanations, markdown, quotes, or any extra characters.",
                        ].join(" "),
                    },
                    {
                        role: "user",
                        content: String(text).slice(0, 1000),
                    },
                ],
            }),
        }, 5000);
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`OPENROUTER_LANG_DETECT_${response.status}: ${errorText.slice(0, 200)}`);
        }
        const data = await response.json();
        const aiText = String(data?.choices?.[0]?.message?.content || "").trim().toLowerCase();
        const code = aiText.match(/\b(ru|kk)\b/)?.[1];
        return code === "ru" ? "ru" : "kk";
    }
    catch (error) {
        console.error("[AI LANG DETECT] failed:", error?.message || error);
        return "kk";
    }
}
export async function detectLangWithFallback(text, storedLang) {
    if (storedLang === "kk" || storedLang === "ru")
        return storedLang;
    if (KAZAKH_RE.test(text || ""))
        return "kk";
    return detectLanguageWithAI(text || "");
}

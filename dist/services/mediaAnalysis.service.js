import { generateMediaText } from "./llm.service.js";
function stripDataUrl(base64Media = "") {
    return base64Media.includes(",") ? base64Media.split(",")[1] : base64Media;
}
function extractJson(text = "") {
    const cleanText = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
    const start = cleanText.indexOf("{");
    const end = cleanText.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start)
        return null;
    try {
        return JSON.parse(cleanText.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
function fallbackTechnicalError(error, userLang) {
    const message = error instanceof Error ? error.message : String(error || "media analysis failed");
    const reply = userLang === "ru"
        ? "РР·РІРёРЅРёС‚Рµ, СЃРµР№С‡Р°СЃ РЅРµ РїРѕР»СѓС‡РёР»РѕСЃСЊ РѕР±СЂР°Р±РѕС‚Р°С‚СЊ С„Р°Р№Р». РџРѕРїСЂРѕР±СѓР№С‚Рµ РѕС‚РїСЂР°РІРёС‚СЊ РµРіРѕ РµС‰Рµ СЂР°Р· С‡СѓС‚СЊ РїРѕР·Р¶Рµ."
        : "РљРµС€С–СЂС–ТЈС–Р·, С„Р°Р№Р»РґС‹ Т›Р°Р·С–СЂ У©ТЈРґРµР№ Р°Р»РјР°РґС‹Рј. РЎУ™Р»РґРµРЅ СЃРѕТЈ Т›Р°Р№С‚Р° Р¶С–Р±РµСЂС–Рї РєУ©СЂС–ТЈС–Р·С€С–.";
    return {
        type: "technical_error",
        analysis: `${reply} [System Analysis: Media analysis failed: ${message}] [ESCALATE_DEVELOPER]`,
        admin_summary: "",
        reply_to_customer: reply,
        amount: 0,
        bank_name: "",
        sender_name: "",
        order_id: "0",
        date_time: "0",
    };
}
function buildMediaPrompt(mimeType, caption, userLang, isPdf) {
    const pdfInstruction = isPdf
        ? "This is a PDF document. It is usually a bank receipt or payment confirmation. Carefully extract the amount, bank name, and date."
        : mimeType.startsWith("audio/")
            ? "This is an audio/voice message. Transcribe the customer's intent and identify receipts, payment confirmations, complaints, or admin escalation needs."
            : "This is an image. If it shows a bank transfer, Kaspi/Halyk/Jusan screenshot, or a receipt, treat it as a receipt. If it shows food defects, hair, dirt, or a wrong order, treat it as a complaint.";
    return `
[MEDIA TOOL TASK]
Analyze the photo/PDF/audio sent by the customer along with the accompanying text.
${pdfInstruction}

[STRICT PRIORITY]
1. If the image/PDF/audio is a receipt or payment screenshot: return type="receipt".
2. If the customer's text contains a complaint OR the image shows a food/order issue: return type="complaint".
3. If the customer sends a complaint photo with text, do NOT ask "please describe the issue" again. Extract the specific complaint from the text and write it into admin_summary in Kazakh.
4. If the media is irrelevant: return type="reply".

[RECEIPT EXTRACTION]
- amount: number only.
- bank_name: Kaspi, Halyk, Jusan, or the visible bank.
- date_time: visible date/time. Use "0" if missing.
- sender_name: the full sender name visible on the receipt. Use "Р‘РµР»РіС–СЃС–Р·" only if no sender name is visible.

[COMPLAINT ESCALATION]
- admin_summary: specific short summary in Kazakh.
- reply_to_customer: polite apology in the customer's language, mentioning that the issue was passed to the admin.

[CUSTOMER LANGUAGE]: ${userLang === "ru" ? "RUSSIAN" : "KAZAKH"}
[ACCOMPANYING TEXT / CAPTION / BUFFERED TEXT]: ${caption || "[Empty]"}

Return STRICT JSON only:
{
  "type": "receipt" | "complaint" | "reply" | "technical_error",
  "analysis": "customer-facing text",
  "admin_summary": "Kazakh admin summary",
  "amount": number,
  "bank_name": string,
  "sender_name": string,
  "order_id": string,
  "date_time": string
}
`;
}
export async function analyzeMedia(base64Media, mimeType, caption = "", userLang = "kk", isPdf = false, systemPrompt = "") {
    try {
        if (!base64Media)
            return null;
        const rawText = await generateMediaText({
            prompt: buildMediaPrompt(mimeType, caption, userLang, isPdf),
            base64: stripDataUrl(base64Media),
            mimeType,
            systemPrompt,
        });
        const parsed = extractJson(rawText) || {};
        return {
            type: ["receipt", "complaint", "reply", "technical_error"].includes(parsed.type) ? parsed.type : "reply",
            analysis: String(parsed.analysis || parsed.reply_to_customer || rawText || "").trim(),
            admin_summary: String(parsed.admin_summary || "").trim(),
            amount: Number(parsed.amount || 0) || 0,
            bank_name: String(parsed.bank_name || "").trim(),
            sender_name: String(parsed.sender_name || "").trim(),
            order_id: String(parsed.order_id || "0").trim(),
            date_time: String(parsed.date_time || "0").trim(),
        };
    }
    catch (error) {
        console.error("[AI] Media analysis failed:", error instanceof Error ? error.message : error);
        return fallbackTechnicalError(error, userLang);
    }
}

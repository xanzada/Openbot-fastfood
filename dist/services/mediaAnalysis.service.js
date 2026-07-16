const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
function getAudioFormat(mimeType = "") {
    const lower = String(mimeType).toLowerCase();
    const match = lower.match(/audio\/([a-z0-9]+)/);
    const rawFormat = match ? match[1] : "";
    const map = {
        mpeg: "mp3",
        mp3: "mp3",
        wav: "wav",
        xwav: "wav",
        ogg: "ogg",
        opus: "ogg",
        webm: "ogg",
        mp4: "m4a",
        m4a: "m4a",
        aac: "aac",
        flac: "flac",
    };
    return map[rawFormat] || rawFormat || "wav";
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
function getOpenRouterMediaPart(inlineData, filename = "media") {
    if (!inlineData?.data)
        return null;
    const mimeType = inlineData.mimeType || "application/octet-stream";
    const dataUrl = `data:${mimeType};base64,${inlineData.data}`;
    if (mimeType.startsWith("image/")) {
        return {
            type: "image_url",
            image_url: { url: dataUrl },
        };
    }
    if (mimeType === "application/pdf") {
        return {
            type: "file",
            file: {
                filename: filename.endsWith(".pdf") ? filename : "document.pdf",
                file_data: dataUrl,
            },
        };
    }
    if (mimeType.startsWith("audio/")) {
        return {
            type: "input_audio",
            input_audio: {
                data: inlineData.data,
                format: getAudioFormat(mimeType),
            },
        };
    }
    return {
        type: "file",
        file: {
            filename,
            file_data: dataUrl,
        },
    };
}
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
        ? "Извините, сейчас не получилось обработать файл. Попробуйте отправить его еще раз чуть позже."
        : "Кешіріңіз, файлды қазір өңдей алмадым. Сәлден соң қайта жіберіп көріңізші.";
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
export async function analyzeMedia(base64Media, mimeType, caption = "", userLang = "kk", isPdf = false) {
    try {
        if (!base64Media)
            return null;
        if (!OPENROUTER_API_KEY)
            return fallbackTechnicalError(new Error("OPENROUTER_API_KEY_NOT_CONFIGURED"), userLang);
        const pdfInstruction = isPdf
            ? "This is a PDF document. It is usually a bank receipt or payment confirmation. Carefully extract the amount, bank name, and date."
            : mimeType.startsWith("audio/")
                ? "This is an audio/voice message. Transcribe the customer's intent and identify receipts, payment confirmations, complaints, or admin escalation needs."
                : "This is an image. If it shows a bank transfer, Kaspi/Halyk/Jusan screenshot, or a receipt, treat it as a receipt. If it shows food defects, hair, dirt, or a wrong order, treat it as a complaint.";
        const prompt = `
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
- sender_name: the full sender name visible on the receipt. Use "Белгісіз" only if no sender name is visible.

[COMPLAINT ESCALATION]
- admin_summary: specific short summary in Kazakh. Example: "Клиент донерден шаш шықты деп шағымданды".
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
        const cleanData = stripDataUrl(base64Media);
        const mediaPart = getOpenRouterMediaPart({ data: cleanData, mimeType });
        const content = mediaPart ? [{ type: "text", text: prompt }, mediaPart] : prompt;
        const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                model: process.env.OPENROUTER_MEDIA_MODEL || process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash-lite",
                temperature: 0,
                messages: [{ role: "user", content }],
            }),
        }, 30000);
        if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            throw new Error(`OPENROUTER_MEDIA_${response.status}: ${errorText.slice(0, 200)}`);
        }
        const data = await response.json();
        const rawText = String(data?.choices?.[0]?.message?.content || "").trim();
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

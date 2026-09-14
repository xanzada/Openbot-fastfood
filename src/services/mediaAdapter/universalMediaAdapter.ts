import { getLlmWorkspacePools, type LlmKeyEntry } from "../llmWorkspace.service.js";
import { getMediaPrimaryKeys, normalizeGeminiMediaModel } from "../llm.service.js";

export interface UniversalReceiptResult {
  type: "receipt" | "complaint" | "reply" | "technical_error";
  transcript: string;
  analysis: string;
  admin_summary: string;
  amount: number;
  bank_name: string;
  sender_name: string;
  order_id: string;
  date_time: string;
  transaction_id: string;
  is_valid_receipt: boolean;
  validation_reason: string;
  evidence_visible: boolean;
  evidence_detail: string;
}

/**
 * Regex parser for digital receipts (Kaspi Bank, Halyk Bank, Jusan, etc.).
 * Extracts amount, sender, date/time, and transaction reference with 0 LLM tokens and 0 latency.
 */
export function fastParseDigitalReceipt(text: string): UniversalReceiptResult | null {
  if (!text) return null;
  const isKaspi = /kaspi(?:\.kz| bank)?/i.test(text);
  const isHalyk = /halyk(?:\.kz| bank)?|народный банк/i.test(text);
  const isJusan = /jusan/i.test(text);

  if (!isKaspi && !isHalyk && !isJusan && !/квитанция|төлем|чек|перевод/i.test(text)) {
    return null;
  }

  // 1. Amount
  let amount = 0;
  const amountMatch = text.match(/(?:сумма|сомасы|сома|итог|оплата)[:\s]*([0-9\s]+(?:[.,]\d{1,2})?)\s*(?:₸|kzt|тг|тенге)/iu)
    || text.match(/([0-9\s]+(?:[.,]\d{1,2})?)\s*₸/u);
  if (amountMatch) {
    const rawNum = amountMatch[1].replace(/\s+/g, "").replace(",", ".");
    amount = parseFloat(rawNum) || 0;
  }

  // 2. Sender Name
  let senderName = "";
  const senderMatch = text.match(/(?:отправитель|жіберуші|плательщик)[:\s]*([^\n\r]+)/iu);
  if (senderMatch) {
    senderName = senderMatch[1].trim().replace(/\s+/g, " ").slice(0, 60);
  }

  // 3. Date Time
  let dateTime = "0";
  const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4}\s+\d{2}:\d{2}(?::\d{2})?)/);
  if (dateMatch) {
    const [dPart, tPart] = dateMatch[1].split(/\s+/);
    const [day, month, year] = dPart.split(".");
    try {
      const iso = new Date(`${year}-${month}-${day}T${tPart}`).toISOString();
      if (!isNaN(Date.parse(iso))) dateTime = iso;
    } catch {
      dateTime = dateMatch[1];
    }
  }

  // 4. Transaction / Reference ID
  let transactionId = "";
  const txMatch = text.match(/(?:номер перевода|транзакция|аударым нөмірі|квитанция №|код авторизации)[:\s]*([A-Za-z0-9_-]+)/iu)
    || text.match(/(?:чек №|№)[:\s]*([0-9]{6,})/iu);
  if (txMatch) {
    transactionId = txMatch[1].trim();
  }

  const bankName = isKaspi ? "Kaspi" : isHalyk ? "Halyk" : isJusan ? "Jusan" : "Bank";

  if (amount > 0 && (senderName || transactionId || dateTime !== "0")) {
    return {
      type: "receipt",
      transcript: "",
      analysis: `${bankName} digital receipt: ${amount} ₸ (${senderName || "Клиент"})`,
      admin_summary: `${bankName} чегі: ${amount} ₸, ${senderName || "белгісіз"}`,
      amount,
      bank_name: bankName,
      sender_name: senderName || "Белгісіз",
      order_id: "0",
      date_time: dateTime,
      transaction_id: transactionId || "digital_pdf",
      is_valid_receipt: true,
      validation_reason: "ok",
      evidence_visible: true,
      evidence_detail: "",
    };
  }

  return null;
}

/**
 * Universal OCR Perception Fallback:
 * If the active media model in workspace fails (e.g. text-only model like GLM-5.3-flash
 * returning 400 Bad Request / unsupported modality), this function runs OCR perception
 * via the workspace OCR pool or Gemini Vision free rotation, extracting structured receipt/complaint JSON.
 */
export async function runOcrPerception(
  base64Image: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  const workspace = getLlmWorkspacePools();
  const ocrEntries: LlmKeyEntry[] = workspace?.ocr || [];

  // 1. Try workspace OCR entries
  for (const entry of ocrEntries) {
    if (!entry.key || (entry as any).enabled === false) continue;
    try {
      if (entry.type === "gemini") {
        const base = String(entry.baseUrl || "").replace(/\/+$/, "") || "https://generativelanguage.googleapis.com/v1beta";
        const model = normalizeGeminiMediaModel(entry.model || "gemini-2.5-flash");
        const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(entry.key.trim())}`;
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                { inlineData: { mimeType: mimeType || "image/png", data: base64Image } }
              ]
            }],
            generationConfig: { temperature: 0, responseMimeType: "application/json" }
          }),
          signal: AbortSignal.timeout(25_000)
        });
        if (res.ok) {
          const json = await res.json() as any;
          const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("");
          if (text) return text;
        }
      }
    } catch (e) {
      console.warn(`[UMA:OCR] entry ${entry.name} failed:`, e);
    }
  }

  // 2. Fallback to Gemini Free Keys (0% host CPU/RAM)
  const geminiKeys = getMediaPrimaryKeys();
  for (let i = 0; i < geminiKeys.length; i++) {
    const key = geminiKeys[i];
    if (!key) continue;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key.trim())}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              { inlineData: { mimeType: mimeType || "image/png", data: base64Image } }
            ]
          }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" }
        }),
        signal: AbortSignal.timeout(25_000)
      });
      if (res.ok) {
        const json = await res.json() as any;
        const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("");
        if (text) return text;
      }
    } catch (e) {
      console.warn(`[UMA:OCR] Gemini free key #${i + 1} failed:`, e);
    }
  }

  throw new Error("ALL_OCR_PROVIDERS_FAILED");
}

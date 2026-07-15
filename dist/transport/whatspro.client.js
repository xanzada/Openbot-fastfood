import axios from "axios";
const RESPONSE_CHUNK_MAX = Number(process.env.OPENBOT_RESPONSE_CHUNK_MAX || 650);
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
function maskPhone(phone = "") {
    const clean = String(phone || "").replace(/\D/g, "");
    if (clean.length <= 6)
        return clean || "-";
    // ӨЗГЕРІС: Бірінші санды анық көру үшін масканы 4 санға дейін ұзарттық (мысалы 7707***567)
    return `${clean.slice(0, 4)}***${clean.slice(-3)}`;
}
function hostFromUrl(url = "") {
    try {
        return new URL(url).host;
    }
    catch {
        return url || "-";
    }
}
function whatsproHeaders() {
    const headers = { "content-type": "application/json" };
    if (process.env.WHATSPRO_API_TOKEN) {
        headers.authorization = `Bearer ${process.env.WHATSPRO_API_TOKEN}`;
        headers["x-api-key"] = process.env.WHATSPRO_API_TOKEN;
    }
    return headers;
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomTypingDelayMs() {
    return 1500 + Math.floor(Math.random() * 1500);
}
function pushSized(chunks, value = "") {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text)
        return;
    if (text.length <= RESPONSE_CHUNK_MAX) {
        chunks.push(text);
        return;
    }
    const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) || [text];
    let current = "";
    for (const sentence of sentences) {
        const next = `${current} ${sentence}`.trim();
        if (next.length > RESPONSE_CHUNK_MAX && current) {
            chunks.push(current);
            current = sentence.trim();
        }
        else {
            current = next;
        }
    }
    if (current)
        chunks.push(current.trim());
}
function normalizeUrlForSeparateMessage(url) {
    const u = url.trim().replace(/[.,!?;:]+$/g, "");
    if (u.startsWith("http://") || u.startsWith("https://"))
        return u;
    return u;
}
function normalizeMarkdownLinks(text) {
    return String(text || "").replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, url) => [String(label || "").trim(), String(url || "").trim()].filter(Boolean).join("\n"));
}
export function splitWhatsProResponse(text = "") {
    const cleanText = normalizeMarkdownLinks(String(text || "").trim());
    if (!cleanText)
        return [];
    // Extract all URLs
    const urls = Array.from(new Set((cleanText.match(URL_RE) || []).map(normalizeUrlForSeparateMessage).filter(Boolean)));
    // Remove URLs from text body
    const textOnly = cleanText.replace(URL_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim();
    const chunks = [];
    // Split text-only body into chunks (paragraph-based)
    for (const paragraph of textOnly.split(/\n{2,}/)) {
        pushSized(chunks, paragraph);
    }
    // If there are URLs AND text chunks, URLs go as completely separate messages
    if (urls.length > 0 && chunks.length > 0) {
        // Keep text chunks as-is
        // URLs will be appended as individual separate messages
    }
    for (const url of urls) {
        chunks.push(url);
    }
    return chunks.filter(Boolean);
}
export async function sendWhatsProMessage(payload) {
    const baseUrl = String(process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
    const rawSendUrl = process.env.WHATSPRO_SEND_URL || "";
    let url;
    if (rawSendUrl) {
        try {
            const parsed = new URL(rawSendUrl);
            url = parsed.pathname === "/" || parsed.pathname === "" ? `${rawSendUrl.replace(/\/+$/, "")}/api/send` : rawSendUrl;
        }
        catch {
            url = rawSendUrl;
        }
    }
    else {
        url = baseUrl ? `${baseUrl}/api/send` : "";
    }
    if (!url) {
        console.warn("[OPENBOT:WHATSPRO:SKIP] WHATSPRO_SEND_URL or WHATSPRO_BASE_URL is not configured");
        return { skipped: true, reason: "WHATSPRO_SEND_URL or WHATSPRO_BASE_URL is not configured" };
    }
    const headers = whatsproHeaders();
    const started = Date.now();
    console.log(`[OPENBOT:WHATSPRO] send begin host=${hostFromUrl(url)} instance=${payload.instanceId} phone=${maskPhone(payload.phone)} text_len=${payload.text?.length || 0} media=${payload.media ? "yes" : "no"}`);
    try {
        const response = await axios.post(url, {
            instanceId: payload.instanceId,
            phone: payload.phone,
            text: payload.text,
            media: payload.media,
        }, { timeout: 10000, headers });
        console.log(`[OPENBOT:WHATSPRO:OK] status=${response.status} elapsed=${Date.now() - started}ms instance=${payload.instanceId} phone=${maskPhone(payload.phone)}`);
        return response.data;
    }
    catch (error) {
        console.error(`[OPENBOT:WHATSPRO:FAIL] elapsed=${Date.now() - started}ms instance=${payload.instanceId} phone=${maskPhone(payload.phone)} status=${error?.response?.status || "-"} error=${error?.message || error}`);
        throw error;
    }
}
export async function sendWhatsProPresence(payload) {
    const baseUrl = String(process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
    const rawPresenceUrl = process.env.WHATSPRO_PRESENCE_URL || "";
    let url;
    if (rawPresenceUrl) {
        try {
            const parsed = new URL(rawPresenceUrl);
            url = parsed.pathname === "/" || parsed.pathname === "" ? `${rawPresenceUrl.replace(/\/+$/, "")}/api/presence` : rawPresenceUrl;
        }
        catch {
            url = rawPresenceUrl;
        }
    }
    else {
        url = baseUrl ? `${baseUrl}/api/presence` : "";
    }
    if (!url)
        return { skipped: true, reason: "WHATSPRO_PRESENCE_URL or WHATSPRO_BASE_URL is not configured" };
    try {
        const response = await axios.post(url, {
            instanceId: payload.instanceId,
            phone: payload.phone,
            state: "composing",
        }, { timeout: 3000, headers: whatsproHeaders() });
        return response.data;
    }
    catch (error) {
        console.warn(`[OPENBOT:WHATSPRO:PRESENCE:SKIP] host=${hostFromUrl(url)} instance=${payload.instanceId} phone=${maskPhone(payload.phone)} status=${error?.response?.status || "-"} error=${error?.message || error}`);
        return { skipped: true, reason: error?.message || "presence_failed" };
    }
}
export async function sendWhatsProResponseSequence(payload) {
    const chunks = splitWhatsProResponse(payload.text);
    const sent = [];
    for (let index = 0; index < chunks.length; index += 1) {
        if (index > 0) {
            await sendWhatsProPresence(payload);
            await delay(randomTypingDelayMs());
        }
        sent.push(await sendWhatsProMessage({
            instanceId: payload.instanceId,
            phone: payload.phone,
            text: chunks[index],
        }));
    }
    return { ok: true, chunks: chunks.length, sent };
}

import axios from "axios"; //[cite: 4]
import { auditDecision, auditError, auditOutbound } from "../services/auditLogger.service.js"; //[cite: 4]
import { getRestaurantConfig } from "../services/nocodb.service.js"; //[cite: 4]

const RESPONSE_CHUNK_MAX = Number(process.env.OPENBOT_RESPONSE_CHUNK_MAX || 650); //[cite: 4]
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi; //[cite: 4]

function maskPhone(phone = "") { //[cite: 4]
    const clean = String(phone || "").replace(/\D/g, ""); //[cite: 4]
    if (clean.length <= 6) //[cite: 4]
        return clean || "-"; //[cite: 4]
    return `${clean.slice(0, 4)}***${clean.slice(-3)}`; //[cite: 4]
}

function hostFromUrl(url = "") { //[cite: 4]
    try {
        return new URL(url).host; //[cite: 4]
    }
    catch {
        return url || "-"; //[cite: 4]
    }
}

function firstValue(...values) { //[cite: 4]
    for (const value of values) { //[cite: 4]
        if (value !== undefined && value !== null && String(value).trim() !== "") //[cite: 4]
            return String(value).trim(); //[cite: 4]
    }
    return ""; //[cite: 4]
}

function whatsproHeaders(apiToken = "") { //[cite: 4]
    const headers = { "content-type": "application/json" }; //[cite: 4]
    if (apiToken) { //[cite: 4]
        headers.authorization = `Bearer ${apiToken}`; //[cite: 4]
        headers["x-api-key"] = apiToken; //[cite: 4]
    }
    return headers; //[cite: 4]
}

async function resolveWhatsProTransport(instanceId) { //[cite: 4]
    const config = (await getRestaurantConfig(instanceId).catch(() => null)) || {}; //[cite: 4]
    const baseUrl = firstValue(config.whatspro_base_url, config.whatsproBaseUrl).replace(/\/+$/, ""); //[cite: 4]
    return { //[cite: 4]
        baseUrl, //[cite: 4]
        sendUrl: firstValue(config.whatspro_send_url, config.whatsproSendUrl), //[cite: 4]
        presenceUrl: firstValue(config.whatspro_presence_url, config.whatsproPresenceUrl), //[cite: 4]
        apiToken: firstValue(config.whatspro_api_token, config.whatsproApiToken), //[cite: 4]
        source: "tenant_nocodb", //[cite: 4]
        tenantFound: Boolean(config.instance_id || config.instance), //[cite: 4]
    };
}

function endpointFromTransport(rawUrl, baseUrl, path) { //[cite: 4]
    if (rawUrl) { //[cite: 4]
        try { //[cite: 4]
            const parsed = new URL(rawUrl); //[cite: 4]
            return parsed.pathname === "/" || parsed.pathname === "" ? `${rawUrl.replace(/\/+$/, "")}${path}` : rawUrl; //[cite: 4]
        }
        catch { //[cite: 4]
            return rawUrl; //[cite: 4]
        }
    }
    return baseUrl ? `${baseUrl}${path}` : ""; //[cite: 4]
}

function delay(ms) { //[cite: 4]
    return new Promise((resolve) => setTimeout(resolve, ms)); //[cite: 4]
}

function randomTypingDelayMs() { //[cite: 4]
    return 1500 + Math.floor(Math.random() * 1500); //[cite: 4]
}

function pushSized(chunks, value = "") { //[cite: 4]
    const text = value.replace(/\s+/g, " ").trim(); //[cite: 4]
    if (!text) //[cite: 4]
        return; //[cite: 4]
    if (text.length <= RESPONSE_CHUNK_MAX) { //[cite: 4]
        chunks.push(text); //[cite: 4]
        return; //[cite: 4]
    }
    const sentences = text.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/gu) || [text]; //[cite: 4]
    let current = ""; //[cite: 4]
    for (const sentence of sentences) { //[cite: 4]
        const next = `${current} ${sentence}`.trim(); //[cite: 4]
        if (next.length > RESPONSE_CHUNK_MAX && current) { //[cite: 4]
            chunks.push(current); //[cite: 4]
            current = sentence.trim(); //[cite: 4]
        }
        else { //[cite: 4]
            current = next; //[cite: 4]
        }
    }
    if (current) //[cite: 4]
        chunks.push(current.trim()); //[cite: 4]
}

function normalizeUrlForSeparateMessage(url) { //[cite: 4]
    const u = url.trim().replace(/[.,!?;:]+$/g, ""); //[cite: 4]
    if (u.startsWith("http://") || u.startsWith("https://")) //[cite: 4]
        return u; //[cite: 4]
    return u; //[cite: 4]
}

function normalizeMarkdownLinks(text) { //[cite: 4]
    return String(text || "").replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, url) => [String(label || "").trim(), String(url || "").trim()].filter(Boolean).join("\n")); //[cite: 4]
}

export function splitWhatsProResponse(text = "") { //[cite: 4]
    const cleanText = normalizeMarkdownLinks(String(text || "").trim()); //[cite: 4]
    if (!cleanText) //[cite: 4]
        return []; //[cite: 4]
    const urls = Array.from(new Set((cleanText.match(URL_RE) || []).map(normalizeUrlForSeparateMessage).filter(Boolean))); //[cite: 4]
    const textOnly = cleanText.replace(URL_RE, "").replace(/[ \t]+\n/g, "\n").replace(/\s{2,}/g, " ").trim(); //[cite: 4]
    const chunks = []; //[cite: 4]
    for (const paragraph of textOnly.split(/\n{2,}/)) { //[cite: 4]
        pushSized(chunks, paragraph); //[cite: 4]
    }
    for (const url of urls) { //[cite: 4]
        chunks.push(url); //[cite: 4]
    }
    return chunks.filter(Boolean); //[cite: 4]
}

export async function sendWhatsProMessage(payload) { //[cite: 4]
    const transport = await resolveWhatsProTransport(payload.instanceId); //[cite: 4]
    const url = endpointFromTransport(transport.sendUrl, transport.baseUrl, "/api/send"); //[cite: 4]
    if (!url) { //[cite: 4]
        auditDecision("WhatsPro outbound skipped: send URL not configured", { //[cite: 4]
            instance: payload.instanceId, //[cite: 4]
            tenantFound: transport.tenantFound, //[cite: 4]
            hasTenantToken: Boolean(transport.apiToken), //[cite: 4]
            phone: payload.phone, //[cite: 4]
            textLength: payload.text?.length || 0, //[cite: 4]
            media: Boolean(payload.media), //[cite: 4]
        });
        return { skipped: true, reason: "tenant whatspro_send_url/whatspro_base_url is not configured" }; //[cite: 4]
    }
    const headers = whatsproHeaders(transport.apiToken); //[cite: 4]
    if (!transport.apiToken) { //[cite: 4]
        auditDecision("WhatsPro outbound skipped: tenant API token not configured", { //[cite: 4]
            instance: payload.instanceId, //[cite: 4]
            tenantFound: transport.tenantFound, //[cite: 4]
            phone: payload.phone, //[cite: 4]
            textLength: payload.text?.length || 0, //[cite: 4]
            media: Boolean(payload.media), //[cite: 4]
        });
        return { skipped: true, reason: "tenant whatspro_api_token is not configured" }; //[cite: 4]
    }
    const started = Date.now(); //[cite: 4]
    auditOutbound("WhatsPro send begin", { //[cite: 4]
        to: payload.phone, //[cite: 4]
        phone: payload.phone, //[cite: 4]
        maskedPhone: maskPhone(payload.phone), //[cite: 4]
        text: payload.text, //[cite: 4]
        textLength: payload.text?.length || 0, //[cite: 4]
        instance: payload.instanceId, //[cite: 4]
        host: hostFromUrl(url), //[cite: 4]
        media: Boolean(payload.media), //[cite: 4]
        transportSource: transport.source, //[cite: 4]
    });
    try {
        const response = await axios.post(url, { //[cite: 4]
            instanceId: payload.instanceId, //[cite: 4]
            phone: payload.phone, //[cite: 4]
            text: payload.text, //[cite: 4]
            media: payload.media, //[cite: 4]
        }, { timeout: 10000, headers }); //[cite: 4]
        auditOutbound("WhatsPro send success", { //[cite: 4]
            to: payload.phone, //[cite: 4]
            phone: payload.phone, //[cite: 4]
            maskedPhone: maskPhone(payload.phone), //[cite: 4]
            text: payload.text, //[cite: 4]
            status: response.status, //[cite: 4]
            elapsedMs: Date.now() - started, //[cite: 4]
            instance: payload.instanceId, //[cite: 4]
            host: hostFromUrl(url), //[cite: 4]
            transportSource: transport.source, //[cite: 4]
            response: response.data, //[cite: 4]
        });
        return response.data; //[cite: 4]
    }
    catch (error) { //[cite: 4]
        auditError("WhatsPro send failed", error, { //[cite: 4]
            failedStep: "whatspro_send_message", //[cite: 4]
            to: payload.phone, //[cite: 4]
            phone: payload.phone, //[cite: 4]
            maskedPhone: maskPhone(payload.phone), //[cite: 4]
            text: payload.text, //[cite: 4]
            status: error?.response?.status || "-", //[cite: 4]
            response: error?.response?.data, //[cite: 4]
            elapsedMs: Date.now() - started, //[cite: 4]
            instance: payload.instanceId, //[cite: 4]
            host: hostFromUrl(url), //[cite: 4]
            transportSource: transport.source, //[cite: 4]
        });
        throw error; //[cite: 4]
    }
}

export async function sendWhatsProPresence(payload) { //[cite: 4]
    const transport = await resolveWhatsProTransport(payload.instanceId); //[cite: 4]
    const url = endpointFromTransport(transport.presenceUrl, transport.baseUrl, "/api/presence"); //[cite: 4]
    if (!url) //[cite: 4]
        return { skipped: true, reason: "tenant whatspro_presence_url/whatspro_base_url is not configured" }; //[cite: 4]
    if (!transport.apiToken) //[cite: 4]
        return { skipped: true, reason: "tenant whatspro_api_token is not configured" }; //[cite: 4]
    try {
        const response = await axios.post(url, { //[cite: 4]
            instanceId: payload.instanceId, //[cite: 4]
            phone: payload.phone, //[cite: 4]
            state: "composing", //[cite: 4]
        }, { timeout: 1500, headers: whatsproHeaders(transport.apiToken) }); // ӨЗГЕРІС: timeout 3000-нен 1500-ге қысқартылды
        return response.data; //[cite: 4]
    }
    catch (error) { //[cite: 4]
        // ӨЗГЕРІС: 404 қатесін логиканы бұзбайтындай үнсіз өткізіп жіберу 
        if (error?.response?.status === 404) {
            return { skipped: true, reason: "presence_endpoint_not_supported_404" };
        }
        
        auditError("WhatsPro presence skipped", error, { //[cite: 4]
            failedStep: "whatspro_presence", //[cite: 4]
            host: hostFromUrl(url), //[cite: 4]
            instance: payload.instanceId, //[cite: 4]
            phone: payload.phone, //[cite: 4]
            maskedPhone: maskPhone(payload.phone), //[cite: 4]
            status: error?.response?.status || "-", //[cite: 4]
            response: error?.response?.data, //[cite: 4]
            transportSource: transport.source, //[cite: 4]
        });
        return { skipped: true, reason: error?.message || "presence_failed" }; //[cite: 4]
    }
}

export async function sendWhatsProResponseSequence(payload) { //[cite: 4]
    const chunks = splitWhatsProResponse(payload.text); //[cite: 4]
    const sent = []; //[cite: 4]
    for (let index = 0; index < chunks.length; index += 1) { //[cite: 4]
        if (index > 0) { //[cite: 4]
            await sendWhatsProPresence(payload); //[cite: 4]
            await delay(randomTypingDelayMs()); //[cite: 4]
        }
        sent.push(await sendWhatsProMessage({ //[cite: 4]
            instanceId: payload.instanceId, //[cite: 4]
            phone: payload.phone, //[cite: 4]
            text: chunks[index], //[cite: 4]
        }));
    }
    return { ok: true, chunks: chunks.length, sent }; //[cite: 4]
}
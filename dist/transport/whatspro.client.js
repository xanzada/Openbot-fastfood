import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";
import { auditDecision, auditError, auditOutbound } from "../services/auditLogger.service.js";
import { getRestaurantConfig } from "../services/platformConfig.service.js";
import crypto from "node:crypto";
import { connectRedis, redisClient, scanKeys } from "../services/redis.service.js";
const RESPONSE_CHUNK_MAX = Math.max(180, Number(process.env.OPENBOT_RESPONSE_CHUNK_MAX || 320));
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const volatileOutbox = new Map();
let outboxTimer = null;
const outboxDirectory = path.resolve(process.env.OPENBOT_OUTBOX_DIR ||
    (process.env.NODE_ENV === "production"
        ? "/app/state/whatspro-outbox"
        : path.join(process.cwd(), ".openbot-outbox")));
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
function firstValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== "")
            return String(value).trim();
    }
    return "";
}
// The instance travels in a header as well as the body. WhatsPro authenticates
// /api/send before parsing the body — it will not run a 23mb parse for an
// unauthenticated caller — so a per-restaurant token has nothing to scope itself
// to unless the header is there. The gateway then checks the two agree.
function whatsproHeaders(apiToken = "", instanceId = "") {
    const headers = { "content-type": "application/json" };
    if (apiToken) {
        headers.authorization = `Bearer ${apiToken}`;
        headers["x-api-key"] = apiToken;
    }
    if (instanceId)
        headers["x-chat-instance"] = instanceId;
    return headers;
}
async function resolveWhatsProTransport(instanceId) {
    const config = (await getRestaurantConfig(instanceId).catch(() => null)) || {};
    const baseUrl = firstValue(config.whatspro_base_url, config.whatsproBaseUrl).replace(/\/+$/, "");
    return {
        baseUrl,
        sendUrl: firstValue(config.whatspro_send_url, config.whatsproSendUrl),
        presenceUrl: firstValue(config.whatspro_presence_url, config.whatsproPresenceUrl),
        apiToken: firstValue(config.whatspro_api_token, config.whatsproApiToken),
        source: "tenant_platform",
        tenantFound: Boolean(config.instance_id || config.instance),
    };
}
function endpointFromTransport(rawUrl, baseUrl, path) {
    if (rawUrl) {
        try {
            const parsed = new URL(rawUrl);
            return parsed.pathname === "/" || parsed.pathname === "" ? `${rawUrl.replace(/\/+$/, "")}${path}` : rawUrl;
        }
        catch {
            return rawUrl;
        }
    }
    return baseUrl ? `${baseUrl}${path}` : "";
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function randomTypingDelayMs() {
    return 900 + Math.floor(Math.random() * 1400);
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
        const cleanSentence = sentence.trim();
        const next = `${current} ${cleanSentence}`.trim();
        if (next.length > RESPONSE_CHUNK_MAX && current) {
            chunks.push(current);
            current = cleanSentence;
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
    const transport = await resolveWhatsProTransport(payload.instanceId);
    const url = endpointFromTransport(transport.sendUrl, transport.baseUrl, "/api/send");
    if (!url) {
        auditDecision("WhatsPro outbound skipped: send URL not configured", {
            instance: payload.instanceId,
            tenantFound: transport.tenantFound,
            hasTenantToken: Boolean(transport.apiToken),
            phone: payload.phone,
            textLength: payload.text?.length || 0,
            media: Boolean(payload.media),
        });
        return { skipped: true, reason: "tenant whatspro_send_url/whatspro_base_url is not configured" };
    }
    const headers = whatsproHeaders(transport.apiToken, payload.instanceId);
    if (!transport.apiToken) {
        auditDecision("WhatsPro outbound skipped: tenant API token not configured", {
            instance: payload.instanceId,
            tenantFound: transport.tenantFound,
            phone: payload.phone,
            textLength: payload.text?.length || 0,
            media: Boolean(payload.media),
        });
        return { skipped: true, reason: "tenant whatspro_api_token is not configured" };
    }
    const started = Date.now();
    auditOutbound("WhatsPro send begin", {
        to: payload.phone,
        phone: payload.phone,
        maskedPhone: maskPhone(payload.phone),
        text: payload.text,
        textLength: payload.text?.length || 0,
        instance: payload.instanceId,
        host: hostFromUrl(url),
        media: Boolean(payload.media),
        transportSource: transport.source,
    });
    try {
        const response = await axios.post(url, {
            instanceId: payload.instanceId,
            phone: payload.phone,
            text: payload.text,
            media: payload.media,
            requestId: payload.requestId,
        }, { timeout: 10000, headers });
        const acknowledged = response.status >= 200 && response.status < 300 && response.data?.success === true;
        if (!acknowledged) {
            const error = new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
            error.code = "WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED";
            error.response = response;
            throw error;
        }
        auditOutbound("WhatsPro send success", {
            to: payload.phone,
            phone: payload.phone,
            maskedPhone: maskPhone(payload.phone),
            text: payload.text,
            status: response.status,
            elapsedMs: Date.now() - started,
            instance: payload.instanceId,
            host: hostFromUrl(url),
            transportSource: transport.source,
            response: response.data,
        });
        return { ...response.data, ok: true, acknowledged: true };
    }
    catch (error) {
        auditError("WhatsPro send failed", error, {
            failedStep: "whatspro_send_message",
            to: payload.phone,
            phone: payload.phone,
            maskedPhone: maskPhone(payload.phone),
            text: payload.text,
            status: error?.response?.status || "-",
            response: error?.response?.data,
            elapsedMs: Date.now() - started,
            instance: payload.instanceId,
            host: hostFromUrl(url),
            transportSource: transport.source,
        });
        throw error;
    }
}
async function persistOutbox(record) {
    volatileOutbox.set(record.id, record);
    try {
        await fs.mkdir(outboxDirectory, { recursive: true, mode: 0o700 });
        const target = path.join(outboxDirectory, `${record.id}.json`);
        const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(record), { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, target);
    }
    catch (error) {
        auditError("WhatsPro file outbox write failed", error, {
            failedStep: "whatspro_file_outbox_write",
            instance: record.instanceId,
            outboxId: record.id,
        });
    }
    try {
        await connectRedis();
        await redisClient.setEx(`outbox:whatspro:${record.id}`, 7 * 24 * 60 * 60, JSON.stringify(record));
    }
    catch {
        // The process-local copy keeps retrying while Redis reconnects.
    }
}
async function removeOutbox(id) {
    volatileOutbox.delete(id);
    await fs.unlink(path.join(outboxDirectory, `${id}.json`)).catch((error) => {
        if (error?.code !== "ENOENT") {
            auditError("WhatsPro file outbox cleanup failed", error, {
                failedStep: "whatspro_file_outbox_cleanup",
                outboxId: id,
            });
        }
    });
    try {
        await connectRedis();
        await redisClient.del(`outbox:whatspro:${id}`);
    }
    catch {
        // A replay is safe because the same requestId reaches WhatsPro idempotency.
    }
}
export async function getWhatsProOutboxSummary() {
    const filePending = await fs.readdir(outboxDirectory)
        .then((names) => names.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length)
        .catch(() => 0);
    let redisPending = 0;
    try {
        redisPending = (await scanKeys("outbox:whatspro:*")).length;
    }
    catch {
        redisPending = -1;
    }
    return {
        volatilePending: volatileOutbox.size,
        filePending,
        redisPending,
    };
}
export async function drainWhatsProOutbox(limit = 25) {
    const records = new Map(volatileOutbox);
    try {
        const names = (await fs.readdir(outboxDirectory))
            .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
            .slice(0, limit);
        for (const name of names) {
            try {
                const record = JSON.parse(await fs.readFile(path.join(outboxDirectory, name), "utf8"));
                if (record?.id && record?.instanceId && record?.phone && record?.text)
                    records.set(record.id, record);
            }
            catch {
                await fs.unlink(path.join(outboxDirectory, name)).catch(() => undefined);
            }
        }
    }
    catch {
        // The Redis and process-local copies remain available.
    }
    try {
        const keys = await scanKeys("outbox:whatspro:*");
        for (const key of keys.slice(0, limit)) {
            const raw = await redisClient.get(key);
            if (!raw)
                continue;
            try {
                const record = JSON.parse(raw);
                if (record?.id && record?.instanceId && record?.phone && record?.text)
                    records.set(record.id, record);
            }
            catch {
                await redisClient.del(key);
            }
        }
    }
    catch {
        // Redis will be retried by the connection manager; volatile records remain.
    }
    let delivered = 0;
    for (const record of [...records.values()].slice(0, limit)) {
        if (Number(record.nextAttemptAt || 0) > Date.now())
            continue;
        try {
            const result = await sendWhatsProMessage({
                instanceId: record.instanceId,
                phone: record.phone,
                text: record.text,
                requestId: record.id,
            });
            if (result?.acknowledged !== true)
                throw new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
            await removeOutbox(record.id);
            delivered += 1;
        }
        catch (error) {
            const attempts = Number(record.attempts || 0) + 1;
            await persistOutbox({
                ...record,
                attempts,
                nextAttemptAt: Date.now() + Math.min(5 * 60_000, 2_000 * (2 ** Math.min(attempts, 7))),
                error: String(error?.message || error || "delivery_failed"),
            });
        }
    }
    return { checked: Math.min(records.size, limit), delivered, pending: records.size - delivered };
}
export function startWhatsProOutboxWorker() {
    if (outboxTimer)
        return outboxTimer;
    void drainWhatsProOutbox().catch(() => undefined);
    outboxTimer = setInterval(() => {
        void drainWhatsProOutbox().catch((error) => {
            auditError("WhatsPro outbox drain failed", error, { failedStep: "whatspro_outbox_drain" });
        });
    }, Math.max(2_000, Number(process.env.OPENBOT_OUTBOX_INTERVAL_MS || 10_000)));
    outboxTimer.unref?.();
    return outboxTimer;
}
export async function sendWhatsProPresence(payload) {
    const transport = await resolveWhatsProTransport(payload.instanceId);
    const url = endpointFromTransport(transport.presenceUrl, transport.baseUrl, "/api/presence");
    if (!url)
        return { skipped: true, reason: "tenant whatspro_presence_url/whatspro_base_url is not configured" };
    if (!transport.apiToken)
        return { skipped: true, reason: "tenant whatspro_api_token is not configured" };
    try {
        const response = await axios.post(url, {
            instanceId: payload.instanceId,
            phone: payload.phone,
            state: "composing",
        }, { timeout: 3000, headers: whatsproHeaders(transport.apiToken, payload.instanceId) });
        return response.data;
    }
    catch (error) {
        auditError("WhatsPro presence skipped", error, {
            failedStep: "whatspro_presence",
            host: hostFromUrl(url),
            instance: payload.instanceId,
            phone: payload.phone,
            maskedPhone: maskPhone(payload.phone),
            status: error?.response?.status || "-",
            response: error?.response?.data,
            transportSource: transport.source,
        });
        return { skipped: true, reason: error?.message || "presence_failed" };
    }
}
export function startWhatsProTyping(payload) {
    let stopped = false;
    const pulse = () => {
        if (!stopped)
            void sendWhatsProPresence(payload).catch(() => undefined);
    };
    pulse();
    // WhatsApp presence expires after a few seconds; 3s keeps "typing..." alive
    // through the whole turn (buffer + think + generation + send).
    const timer = setInterval(pulse, 3000);
    timer.unref?.();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
/**
 * Blue-tick read receipt over the presence channel.
 *
 * The gateway exposes /api/presence (verified to exist); read states ride the
 * same channel, so the customer immediately sees their message was read the
 * moment the guard accepts it - long before the answer is generated. Fire and
 * forget: a gateway that does not map the read state simply ignores it.
 */
export async function markWhatsProChatRead(payload) {
    try {
        const transport = await resolveWhatsProTransport(payload.instanceId);
        const url = endpointFromTransport(transport.presenceUrl, transport.baseUrl, "/api/presence");
        if (!url || !transport.apiToken)
            return;
        await axios.post(url, {
            instanceId: payload.instanceId,
            phone: payload.phone,
            state: String(process.env.WHATSPRO_READ_STATE || "read"),
        }, { timeout: 2500, headers: whatsproHeaders(transport.apiToken, payload.instanceId) });
    }
    catch {
        // Read receipts are a courtesy; never let them delay or break a reply.
    }
}
export async function sendWhatsProResponseSequence(payload) {
    const chunks = splitWhatsProResponse(payload.text);
    if (!chunks.length)
        throw new Error("WHATSPRO_EMPTY_RESPONSE");
    // Stable for retries of one inbound message, but unique for a later customer
    // turn that happens to produce the same reply text.
    const requestScope = String(payload.requestScope || crypto.randomUUID());
    const sent = [];
    for (let index = 0; index < chunks.length; index += 1) {
        await sendWhatsProPresence(payload);
        if (index > 0)
            await delay(randomTypingDelayMs());
        const outboundId = crypto.createHash("sha256")
            .update(`${payload.instanceId}|${payload.phone}|${requestScope}|${index}|${chunks[index]}`)
            .digest("hex");
        let result = null;
        let lastError = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            try {
                result = await sendWhatsProMessage({
                    instanceId: payload.instanceId,
                    phone: payload.phone,
                    text: chunks[index],
                    requestId: outboundId,
                });
                if (result?.acknowledged === true)
                    break;
                throw new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
            }
            catch (error) {
                lastError = error;
                result = null;
                if (attempt < 3)
                    await delay(300 * 2 ** (attempt - 1));
            }
        }
        if (!result?.acknowledged) {
            await persistOutbox({
                id: outboundId,
                instanceId: payload.instanceId,
                phone: payload.phone,
                text: chunks[index],
                attempts: 3,
                createdAt: Date.now(),
                nextAttemptAt: Date.now() + 5_000,
                error: String(lastError?.message || "delivery_not_acknowledged"),
            });
            throw lastError || new Error("WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED");
        }
        await removeOutbox(outboundId);
        sent.push(result);
    }
    return { ok: sent.length === chunks.length, chunks: chunks.length, sent };
}

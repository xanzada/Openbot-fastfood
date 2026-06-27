import axios from "axios";
import { deleteCache, getJsonCache, setJsonCache } from "./redis.service.js";
const SHPOR_CONTEXT_LIMIT = Number(process.env.SHPOR_CONTEXT_LIMIT || 8);
function cleanInline(value = "", max = 240) {
    const text = String(value || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}
function safeJsonObject(value, fallback = null) {
    if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
function tokenize(value = "") {
    return String(value || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}
function nocodbHeaders() {
    return { "xc-token": process.env.NOCODB_TOKEN || "" };
}
function baseUrl() {
    return String(process.env.NOCODB_URL || "").replace(/\/+$/, "");
}
function tableUrl(tableId) {
    if (!baseUrl() || !tableId)
        throw new Error("NocoDB URL/table id is not configured");
    return `${baseUrl()}/api/v2/tables/${tableId}/records`;
}
export async function getRestaurantConfig(instanceId) {
    const key = `config:${instanceId}`;
    const backupKey = `config_backup:${instanceId}`;
    const cached = await getJsonCache(key);
    if (cached)
        return cached;
    try {
        const response = await axios.get(tableUrl(process.env.NOCODB_TABLE_ID || ""), {
            headers: nocodbHeaders(),
            params: { where: `(instance_id,eq,${instanceId})`, limit: 1 },
            timeout: 10000,
        });
        const records = Array.isArray(response.data?.list) ? response.data.list : [];
        const config = records[0] || null;
        if (config) {
            await setJsonCache(key, 300, config);
            await setJsonCache(backupKey, 604800, config);
        }
        return config;
    }
    catch (error) {
        console.error(`[NOCODB] config read failed (${instanceId}):`, error?.message || error);
        return getJsonCache(backupKey);
    }
}
function extractShporSearchText(item) {
    const memory = safeJsonObject(item.ideal_answer, null);
    if (memory) {
        return [
            memory.intent,
            memory.category,
            ...(Array.isArray(memory.keywords) ? memory.keywords : []),
            ...(Array.isArray(memory.facts) ? memory.facts : []),
            memory.reply_pattern,
            item.question,
            item.category,
        ]
            .filter(Boolean)
            .join(" ");
    }
    return [item.question, item.ideal_answer, item.category].filter(Boolean).join(" ");
}
function scoreShporRecord(item, query = "") {
    const queryTokens = new Set(tokenize(query));
    if (!queryTokens.size)
        return 0;
    const haystackTokens = tokenize(extractShporSearchText(item));
    if (!haystackTokens.length)
        return 0;
    const haystack = new Set(haystackTokens);
    let score = 0;
    for (const token of queryTokens) {
        if (haystack.has(token))
            score += 3;
        else if (haystackTokens.some((value) => value.includes(token) || token.includes(value)))
            score += 1;
    }
    const confidence = Number(safeJsonObject(item.ideal_answer, {})?.confidence || 0) || 0;
    return score > 0 ? score + confidence : 0;
}
function selectRelevantShpor(records = [], query = "", limit = SHPOR_CONTEXT_LIMIT) {
    const safeQuery = cleanInline(query, 500);
    if (safeQuery === "*")
        return records.slice(0, 100);
    if (!safeQuery)
        return [];
    return records
        .map((item) => ({ item, score: scoreShporRecord(item, safeQuery) }))
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, limit))
        .map((row) => row.item);
}
export async function getShporContext(instanceId, query = "") {
    const tableId = process.env.NOCODB_SHPOR_TABLE_ID || "";
    if (!tableId)
        return [];
    const cacheKey = `shpor_context_100:${instanceId}`;
    const cached = await getJsonCache(cacheKey);
    if (cached)
        return selectRelevantShpor(cached, query);
    try {
        const response = await axios.get(tableUrl(tableId), {
            headers: nocodbHeaders(),
            params: { limit: 100, where: `(instance_id,eq,${instanceId})` },
            timeout: 10000,
        });
        const records = Array.isArray(response.data?.list) ? response.data.list : [];
        await setJsonCache(cacheKey, 3600, records);
        return selectRelevantShpor(records, query);
    }
    catch (error) {
        console.error(`[SHPOR] NocoDB read failed (${instanceId}):`, error?.message || error);
        return [];
    }
}
export async function saveToShpor(instanceId, question, answer, category = "general") {
    const tableId = process.env.NOCODB_SHPOR_TABLE_ID || "";
    if (!tableId || question.trim().length < 10 || answer.trim().length < 10)
        return;
    const payload = {
        instance_id: instanceId,
        question: cleanInline(question, 500),
        ideal_answer: cleanInline(answer, 1200),
        category: cleanInline(category, 80),
    };
    await axios.post(tableUrl(tableId), payload, {
        headers: nocodbHeaders(),
        timeout: 10000,
    });
    await deleteCache(`shpor_context_100:${instanceId}`);
}

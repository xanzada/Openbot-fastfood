import axios from "axios";
import { generateText, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { deleteCache, getJsonCache, setJsonCache } from "./redis.service.js";
const SHPOR_CONTEXT_LIMIT = Number(process.env.SHPOR_CONTEXT_LIMIT || 8);
const openrouter = createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY,
});
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
function cleanString(value, fallback = "") {
    const text = String(value ?? fallback ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    return text || fallback;
}
function normalizePhone(value) {
    return String(value || "").replace(/\D/g, "");
}
function normalizeRestaurantConfig(record) {
    if (!record)
        return null;
    const devPhone = normalizePhone(record.dev_phone || record.developer_phone || record.developer || record.devPhone);
    return {
        ...record,
        dev_phone: devPhone,
    };
}
function cleanPromptLine(value, max = 240) {
    return cleanString(value).slice(0, max);
}
function compactStringArray(value, maxItems = 8, maxLength = 120) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[,;\n]+/);
    return source
        .map((item) => cleanPromptLine(item, maxLength))
        .filter(Boolean)
        .filter((item, index, arr) => arr.findIndex((other) => other.toLowerCase() === item.toLowerCase()) === index)
        .slice(0, maxItems);
}
function normalizeShporToolPolicy(value = "") {
    const policy = cleanString(value, "reply_to_customer").toLowerCase();
    const allowed = new Set([
        "reply_to_customer",
        "search_menu",
        "escalate_to_admin",
        "escalate_to_human",
        "cancel_order",
        "register_payment_receipt",
    ]);
    return allowed.has(policy) ? policy : "reply_to_customer";
}
function buildShporMemoryPayload(question, answer, args = {}, category = "faq") {
    const keywords = compactStringArray(args.keywords, 10, 42);
    const facts = compactStringArray(args.facts, 5, 150);
    const fallbackKeywords = compactStringArray(tokenize(`${question} ${answer}`), 8, 42);
    return {
        v: 1,
        kind: "fastfood_second_brain_memory",
        category,
        intent: cleanPromptLine(args.intent || category || "faq", 80),
        keywords: keywords.length ? keywords : fallbackKeywords,
        facts: facts.length ? facts : [cleanPromptLine(answer, 180)].filter(Boolean),
        reply_pattern: cleanPromptLine(args.reply_pattern || answer, 240),
        tool_policy: normalizeShporToolPolicy(args.tool_policy),
        confidence: Math.max(0, Math.min(1, Number(args.confidence || 0.5) || 0.5)),
        source: "gemini_shpor_analysis",
        saved_at: new Date().toISOString(),
    };
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
        const config = normalizeRestaurantConfig(records[0] || null);
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
export async function getAllRestaurantConfigs() {
    const cacheKey = "config:all_restaurants";
    const backupKey = "config_backup:all_restaurants";
    const cached = await getJsonCache(cacheKey);
    if (cached)
        return cached;
    try {
        const response = await axios.get(tableUrl(process.env.NOCODB_TABLE_ID || ""), {
            headers: nocodbHeaders(),
            params: { limit: 1000 },
            timeout: 10000,
        });
        const records = Array.isArray(response.data?.list)
            ? response.data.list
                .filter((record) => String(record?.instance_id || "").trim())
                .map((record) => normalizeRestaurantConfig(record))
                .filter(Boolean)
            : [];
        await setJsonCache(cacheKey, 300, records);
        await setJsonCache(backupKey, 604800, records);
        return records;
    }
    catch (error) {
        console.warn("[NOCODB] all restaurants read failed:", error?.message || error);
        return (await getJsonCache(backupKey)) || [];
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
    if (confidence > 0 && confidence < 0.45)
        return 0;
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
function buildShporSavePayload(instanceId, question, answer, category = "general", memoryPayload = null) {
    const memory = memoryPayload && typeof memoryPayload === "object" && !Array.isArray(memoryPayload) ? memoryPayload : null;
    if (!memory) {
        return {
            instance_id: instanceId,
            question: cleanInline(question, 500),
            ideal_answer: cleanInline(answer, 1200),
            category,
        };
    }
    const keywords = Array.isArray(memory.keywords)
        ? memory.keywords.map((item) => cleanInline(item, 42)).filter(Boolean).slice(0, 10)
        : [];
    const compact = {
        v: Number(memory.v || 1) || 1,
        kind: cleanInline(memory.kind || "fastfood_second_brain_memory", 80),
        category: cleanInline(memory.category || category || "general", 60),
        intent: cleanInline(memory.intent || category || "general", 80),
        keywords,
        facts: Array.isArray(memory.facts) ? memory.facts.map((item) => cleanInline(item, 150)).filter(Boolean).slice(0, 5) : [],
        reply_pattern: cleanInline(memory.reply_pattern || answer, 240),
        tool_policy: cleanInline(memory.tool_policy || "reply_to_customer", 60),
        confidence: Math.max(0, Math.min(1, Number(memory.confidence || 0.5) || 0.5)),
        source: cleanInline(memory.source || "ai_shpor_analysis", 60),
        saved_at: memory.saved_at || new Date().toISOString(),
    };
    return {
        instance_id: instanceId,
        question: cleanInline(`intent=${compact.intent}; keywords=${keywords.join(", ")}; sample=${question}`, 500),
        ideal_answer: JSON.stringify(compact),
        category: compact.category,
    };
}
export async function saveToShpor(instanceId, question, answer, category = "general", memoryPayload = null) {
    try {
        const tableId = process.env.NOCODB_SHPOR_TABLE_ID || "";
        if (!tableId || !question || question.trim().length < 10)
            return;
        if (!answer || answer.trim().length < 10)
            return;
        if (question.toLowerCase().includes("сәлем") && question.length < 15)
            return;
        if (answer.toLowerCase().includes("жүйеде уақытша жүктеме") || answer.toLowerCase().includes("оператор көмегі"))
            return;
        const allContext = await getShporContext(instanceId, "*");
        if (allContext.length >= 100)
            return;
        const currentContext = selectRelevantShpor(allContext, question);
        const payload = buildShporSavePayload(instanceId, question, answer, category, memoryPayload);
        const cleanNewQ = payload.question.toLowerCase().trim();
        const cleanNewA = payload.ideal_answer.toLowerCase().trim();
        for (const item of currentContext) {
            const existingQ = String(item.question || "").toLowerCase().trim();
            const existingA = String(item.ideal_answer || "").toLowerCase().trim();
            if (existingQ === cleanNewQ || existingA === cleanNewA) {
                console.log(`[SHPOR] Duplicate blocked: "${question.substring(0, 20)}..."`);
                return;
            }
        }
        await axios.post(tableUrl(tableId), payload, {
            headers: nocodbHeaders(),
            timeout: 10000,
        });
        await deleteCache(`shpor_context_100:${instanceId}`);
    }
    catch (error) {
        console.error("[SHPOR] save failed:", error?.message || error);
    }
}
export async function evaluateForShpor(question, answer) {
    try {
        if (!question || !answer || /\[ESCALATE_/i.test(String(answer))) {
            return { save: false };
        }
        const systemPrompt = `
You are an expert AI Data Curator for a fast-food restaurant conversational AI.
Decide if this client/bot dialogue should be saved into the "Second Brain" knowledge base.

[RULES]
Use record_shpor_evaluation.
save=false for:
 - Greetings and simple thanks (Сәлем, Рахмет).
 - Basic menu or status requests (Менде заказ бар ма, Қандай пицца бар).
 - System errors or operator handoffs (Жүйеде қате, Операторға бердім).
 - Temporary live facts: wait minutes, current closure, old shift notes, old payment requisites, repeated menu links, or anything that can expire.
save=true ONLY for:
 - Unique complaints, conflict resolution, stable FAQ wording, or highly specific edge cases where the bot gave an exceptionally good and factual answer.
When save=true, produce a compact bot-readable memory:
 - intent: stable snake_case name
 - keywords: short search terms and slang
 - facts: stable lessons only, no temporary live facts
 - reply_pattern: short customer-safe response pattern
 - tool_policy: one of reply_to_customer, search_menu, escalate_to_admin, escalate_to_human, cancel_order, register_payment_receipt
 - confidence: 0..1
category must be one of: complaint, complex_order, faq, trash.
reason must be brief and in Kazakh.
`;
        const result = await generateText({
            model: openrouter("openai/gpt-4o-mini"),
            system: systemPrompt,
            prompt: `[DIALOGUE]\nClient: ${question}\nBot: ${answer}`,
            allowSystemInMessages: true,
            tools: {
                record_shpor_evaluation: tool({
                    description: "Save the decision about whether a dialogue should be stored in the second brain.",
                    inputSchema: z.object({
                        save: z.boolean().describe("true if the dialogue is useful enough to save."),
                        category: z.string().describe("One of complaint, complex_order, faq, trash."),
                        reason: z.string().describe("Brief Kazakh reason for the decision."),
                        intent: z.string().optional().describe("Compact stable intent name. Empty when save=false."),
                        keywords: z.array(z.string()).optional().describe("3-10 short lookup keywords/slang forms. Empty when save=false."),
                        facts: z.array(z.string()).optional().describe("Short stable factual lessons. No temporary live facts."),
                        reply_pattern: z.string().optional().describe("Short customer-safe answer pattern."),
                        tool_policy: z
                            .string()
                            .optional()
                            .describe("Recommended action: reply_to_customer, search_menu, escalate_to_admin, escalate_to_human, cancel_order, or register_payment_receipt."),
                        confidence: z.number().optional().describe("0..1 confidence that this memory is useful and safe."),
                    }),
                }),
            },
            stopWhen: stepCountIs(1),
        });
        const toolCall = result.toolCalls?.[0];
        const args = (toolCall?.args || toolCall?.input || {});
        const category = ["complaint", "complex_order", "faq", "trash"].includes(args.category) ? args.category : "trash";
        const memory = buildShporMemoryPayload(question, answer, args, category);
        const confidence = memory.confidence;
        const save = Boolean(args.save) && category !== "trash" && confidence >= 0.45;
        return {
            save,
            category,
            reason: cleanString(args.reason, "Сақтауға жеткілікті себеп жоқ"),
            memory,
        };
    }
    catch (error) {
        console.error("[SHPOR:EVAL] failed:", error?.message || error);
        return { save: false };
    }
}

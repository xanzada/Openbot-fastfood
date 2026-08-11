import axios from "axios";
import { generateText, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";
import { deleteCache, getJsonCache, setJsonCache } from "./redis.service.js";
import { envNumber } from "../utils/envNumber.js";
const SHPOR_CONTEXT_LIMIT = envNumber(process.env.SHPOR_CONTEXT_LIMIT, 8, { min: 1 });
const runtimeConfigMemory = new Map();
// Fields the platform's multi-tenant index blanks out on purpose; only the
// per-instance endpoint returns them.
const REDACTED_INDEX_FIELDS = ["alemi_secret", "crm_secret_token", "webhook_secret"];
const botControlMemory = new Map();
let allConfigsMemory = null;
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
function firstValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== "")
            return value;
    }
    return "";
}
export function normalizeRestaurantConfig(record, expectedInstanceId = "") {
    if (!record)
        return null;
    const devPhone = normalizePhone(record.dev_phone ||
        record.developer_phone ||
        record.developer ||
        record.devPhone ||
        process.env.OPENBOT_DEVELOPER_PHONE);
    const instanceId = String(firstValue(record.instance_id, record.instance, record.restaurant_instance, record.restaurantInstance)).trim();
    const expected = String(expectedInstanceId || "").trim();
    // Defense in depth: even a misrouted or stale platform response must never be
    // cached under another tenant's key.
    if (expected && instanceId !== expected)
        return null;
    const whatsAppPhone = normalizePhone(firstValue(record.whatsapp_phone, record.whatsappPhone, record.whatspro_phone, record.whatsproPhone, record.bot_phone, record.botPhone, record.receiver_phone, record.receiverPhone, record.instance_phone, record.instancePhone, record.phone));
    return {
        ...record,
        instance_id: instanceId,
        instance: instanceId,
        dev_phone: devPhone,
        bot_enabled: record.bot_enabled === undefined || record.bot_enabled === null ? true : Boolean(record.bot_enabled),
        whatsapp_phone: whatsAppPhone,
        work_hours: cleanString(firstValue(record.work_hours, record.workHours)),
        brand: cleanString(firstValue(record.brand, record.name, record.restaurant_name, record.restaurantName)),
        address: cleanString(firstValue(record.address)),
        whatspro_base_url: firstValue(record.whatspro_base_url, record.whatsproBaseUrl, record.WHATSPRO_BASE_URL),
        whatspro_send_url: firstValue(record.whatspro_send_url, record.whatsproSendUrl, record.WHATSPRO_SEND_URL),
        whatspro_presence_url: firstValue(record.whatspro_presence_url, record.whatsproPresenceUrl, record.WHATSPRO_PRESENCE_URL),
        whatspro_api_token: firstValue(record.whatspro_api_token, record.whatsproApiToken, record.WHATSPRO_API_TOKEN),
        alemi_api_url: firstValue(record.alemi_api_url, record.alemiApiUrl, record.alemi_base_url, record.alemiBaseUrl),
        alemi_instance: firstValue(record.alemi_instance, record.alemiInstance),
        alemi_secret: firstValue(record.alemi_secret, record.alemiSecret, record.alemi_api_secret, record.alemiApiSecret),
        crm_secret_token: firstValue(record.crm_secret_token, record.crmSecretToken, record.secret_token, record.secretToken, record.secret_key, record.secretKey),
    };
}
export async function isTenantBotEnabled(instanceId) {
    const safeInstanceId = String(instanceId || "").trim();
    if (!safeInstanceId)
        return false;
    const memoryControl = botControlMemory.get(safeInstanceId);
    if (memoryControl && memoryControl.expiresAt > Date.now())
        return memoryControl.enabled;
    const key = `bot_control:${safeInstanceId}`;
    const backupKey = `bot_control_backup:${safeInstanceId}`;
    const cached = await getJsonCache(key);
    if (cached && typeof cached.enabled === "boolean") {
        botControlMemory.set(safeInstanceId, { enabled: cached.enabled, expiresAt: Date.now() + 2_000 });
        return cached.enabled;
    }
    try {
        const response = await axios.get(`${platformBaseUrl()}/api/wa/runtime-configs/${encodeURIComponent(safeInstanceId)}`, { headers: platformHeaders(), timeout: 5000 });
        const config = normalizeRestaurantConfig(response.data?.config || null, safeInstanceId);
        if (!config)
            throw new Error("TENANTS_PLATFORM_TENANT_MISMATCH");
        const enabled = config?.bot_enabled !== false;
        const control = { enabled };
        botControlMemory.set(safeInstanceId, { enabled, expiresAt: Date.now() + 2_000 });
        runtimeConfigMemory.set(safeInstanceId, { value: config, expiresAt: Date.now() + 60_000 });
        void Promise.all([
            setJsonCache(key, 2, control),
            setJsonCache(backupKey, 604800, control),
            setJsonCache(`config:${safeInstanceId}`, 300, config),
            setJsonCache(`config_backup:${safeInstanceId}`, 604800, config),
        ]).catch(() => undefined);
        return enabled;
    }
    catch (error) {
        console.warn(`[PLATFORM] bot control read failed (${safeInstanceId}):`, error?.message || error);
        const backup = await getJsonCache(backupKey);
        if (backup && typeof backup.enabled === "boolean")
            return backup.enabled;
        if (memoryControl)
            return memoryControl.enabled;
        const config = await getRestaurantConfig(safeInstanceId);
        return config?.bot_enabled !== false;
    }
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
function platformBaseUrl() {
    return String(process.env.TENANTS_PLATFORM_BASE_URL || process.env.WHATSPRO_BASE_URL || "").replace(/\/+$/, "");
}
function platformHeaders() {
    const token = String(process.env.TENANTS_PLATFORM_API_TOKEN || process.env.WHATSPRO_API_TOKEN || "").trim();
    if (!platformBaseUrl() || !token)
        throw new Error("Tenants platform API is not configured");
    return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}
export async function getRestaurantConfig(instanceId, options = {}) {
    const safeInstanceId = String(instanceId || "").trim();
    const forceRefresh = options.forceRefresh === true;
    // Auth paths need an authoritative read: the stale-tolerant fallbacks (the
    // in-process value and the seven-day config_backup) may still carry a secret
    // the operator has already rotated away.
    const bypassBackup = options.bypassBackup === true;
    const memory = runtimeConfigMemory.get(safeInstanceId);
    if (!forceRefresh && memory && memory.expiresAt > Date.now())
        return memory.value;
    const key = `config:${safeInstanceId}`;
    const backupKey = `config_backup:${safeInstanceId}`;
    const cached = forceRefresh ? null : await getJsonCache(key);
    if (!forceRefresh && cached) {
        runtimeConfigMemory.set(safeInstanceId, { value: cached, expiresAt: Date.now() + 60_000 });
        return cached;
    }
    try {
        const response = await axios.get(`${platformBaseUrl()}/api/wa/runtime-configs/${encodeURIComponent(safeInstanceId)}`, { headers: platformHeaders(), timeout: 10000 });
        const config = normalizeRestaurantConfig(response.data?.config || null, safeInstanceId);
        if (config) {
            runtimeConfigMemory.set(safeInstanceId, { value: config, expiresAt: Date.now() + 60_000 });
            void Promise.all([
                setJsonCache(key, 300, config),
                setJsonCache(backupKey, 604800, config),
            ]).catch(() => undefined);
            return config;
        }
        // Keep the tenant alive with the last known-good platform config during a network interruption.
        if (bypassBackup)
            return null;
        return memory?.value || await getJsonCache(backupKey);
    }
    catch (error) {
        console.error(`[PLATFORM] config read failed (${safeInstanceId}):`, error?.message || error);
        if (bypassBackup)
            return null;
        return memory?.value || await getJsonCache(backupKey);
    }
}
// An operator can rotate a restaurant's Alemi Secret Key at any moment. Both auth
// directions ask for exactly one authoritative re-read here, which bypasses the
// in-process value, the 300s `config:` entry and the seven-day `config_backup:`
// entry, and rewrites all of them so the next normal read is already correct.
// The secret itself is never logged.
export async function refreshRestaurantConfig(instanceId) {
    const safeInstanceId = String(instanceId || "").trim();
    if (!safeInstanceId)
        return null;
    console.warn(`[PLATFORM] forced config refresh (${safeInstanceId})`);
    return getRestaurantConfig(safeInstanceId, { forceRefresh: true, bypassBackup: true });
}
export async function getAllRestaurantConfigs(options = {}) {
    const forceRefresh = options.forceRefresh === true;
    if (!forceRefresh && allConfigsMemory && allConfigsMemory.expiresAt > Date.now())
        return allConfigsMemory.value;
    const cacheKey = "config:all_restaurants";
    const backupKey = "config_backup:all_restaurants";
    const cached = forceRefresh ? null : await getJsonCache(cacheKey);
    if (!forceRefresh && cached) {
        allConfigsMemory = { value: cached, expiresAt: Date.now() + 60_000 };
        return cached;
    }
    try {
        const response = await axios.get(`${platformBaseUrl()}/api/wa/runtime-configs`, {
            headers: platformHeaders(),
            timeout: 10000,
        });
        const records = Array.isArray(response.data?.configs)
            ? response.data.configs
                .map((record) => normalizeRestaurantConfig(record))
                .filter((record) => String(record?.instance_id || record?.instance || "").trim())
                .filter(Boolean)
            : [];
        allConfigsMemory = { value: records, expiresAt: Date.now() + 60_000 };
        for (const config of records) {
            const instance = String(config.instance_id || config.instance || "");
            if (!instance)
                continue;
            // The broad index redacts Alemi secrets, so seeding this record verbatim
            // would blank the secret every caller of getRestaurantConfig() relies on
            // and make every hub call fail with ALEMI_SECRET_NOT_CONFIGURED for the
            // next 60s. Carry the known-good secret fields over instead.
            const previous = runtimeConfigMemory.get(instance)?.value;
            // With no previous entry there is nothing to carry over - a cold boot, or
            // the first index read after the 60s memory expired. Seeding the redacted
            // record then is exactly the failure the merge above prevents, and it is
            // how the boot check reported "tenant carries no alemi_secret" for a
            // tenant whose per-instance config does carry one. Leaving the tenant
            // unseeded costs one by-id read and returns the authoritative record.
            if (!previous)
                continue;
            const merged = { ...config };
            for (const field of REDACTED_INDEX_FIELDS) {
                if (!merged[field] && previous?.[field])
                    merged[field] = previous[field];
            }
            runtimeConfigMemory.set(instance, { value: merged, expiresAt: Date.now() + 60_000 });
        }
        void Promise.all([
            setJsonCache(cacheKey, 300, records),
            setJsonCache(backupKey, 604800, records),
        ]).catch(() => undefined);
        return records;
    }
    catch (error) {
        console.warn("[PLATFORM] all restaurants read failed:", error?.message || error);
        return allConfigsMemory?.value || (await getJsonCache(backupKey)) || [];
    }
}
export async function getRestaurantConfigByWhatsAppPhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized)
        return null;
    const configs = await getAllRestaurantConfigs();
    return (configs.find((config) => {
        const candidates = [
            config.whatsapp_phone,
            config.whatsappPhone,
            config.whatspro_phone,
            config.whatsproPhone,
            config.bot_phone,
            config.botPhone,
            config.receiver_phone,
            config.receiverPhone,
            config.instance_phone,
            config.instancePhone,
            config.phone,
        ].map((value) => normalizePhone(value));
        return candidates.some((candidate) => candidate && candidate === normalized);
    }) || null);
}
export function findRestaurantConfigByAlemiInstance(incomingInstance, configs) {
    const incoming = String(incomingInstance || "").trim();
    if (!incoming)
        return null;
    const matches = (Array.isArray(configs) ? configs : []).filter((config) => {
        const alemiInstance = String(config?.alemi_instance || config?.alemiInstance || "").trim();
        const internalInstance = String(config?.instance_id || config?.instance || "").trim();
        return incoming === alemiInstance || incoming === internalInstance;
    });
    if (matches.length > 1) {
        const error = new Error("ALEMI_INSTANCE_AMBIGUOUS");
        error.statusCode = 409;
        throw error;
    }
    return matches[0] || null;
}
export async function getRestaurantConfigByAlemiInstance(incomingInstance) {
    const configs = await getAllRestaurantConfigs();
    const cachedMatch = findRestaurantConfigByAlemiInstance(incomingInstance, configs);
    if (cachedMatch) {
        const internalInstance = String(cachedMatch.instance_id || cachedMatch.instance || "").trim();
        // The broad SaaS index intentionally redacts Alemi secrets. Hydrate only
        // the matched tenant through the master-protected per-instance endpoint.
        return internalInstance
            ? await getRestaurantConfig(internalInstance, { forceRefresh: true })
            : null;
    }
    // A newly onboarded restaurant must work without waiting for the five-minute
    // Redis cache. Only a miss forces one platform refresh, keeping the hot path
    // cached while meeting the no-redeploy SaaS onboarding contract.
    const freshConfigs = await getAllRestaurantConfigs({ forceRefresh: true });
    const freshMatch = findRestaurantConfigByAlemiInstance(incomingInstance, freshConfigs);
    if (!freshMatch)
        return null;
    const internalInstance = String(freshMatch.instance_id || freshMatch.instance || "").trim();
    return internalInstance
        ? await getRestaurantConfig(internalInstance, { forceRefresh: true })
        : null;
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
    const safeInstanceId = String(instanceId || "").trim();
    if (!safeInstanceId)
        return [];
    const cacheKey = `shpor_context_100:${safeInstanceId}`;
    const cached = await getJsonCache(cacheKey);
    if (cached)
        return selectRelevantShpor(cached, query);
    try {
        const response = await axios.get(`${platformBaseUrl()}/api/wa/runtime-configs/${encodeURIComponent(safeInstanceId)}/memories`, {
            headers: platformHeaders(),
            timeout: 10000,
        });
        const records = Array.isArray(response.data?.memories)
            ? response.data.memories.filter((item) => String(item?.instance_id || "").trim() === safeInstanceId)
            : [];
        await setJsonCache(cacheKey, 3600, records);
        return selectRelevantShpor(records, query);
    }
    catch (error) {
        console.error(`[SHPOR] platform read failed (${safeInstanceId}):`, error?.message || error);
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
        const safeInstanceId = String(instanceId || "").trim();
        if (!safeInstanceId)
            return;
        if (!question || question.trim().length < 10)
            return;
        if (!answer || answer.trim().length < 10)
            return;
        if (question.toLowerCase().includes("сәлем") && question.length < 15)
            return;
        if (answer.toLowerCase().includes("жүйеде уақытша жүктеме") || answer.toLowerCase().includes("оператор көмегі"))
            return;
        const allContext = await getShporContext(safeInstanceId, "*");
        if (allContext.length >= 100)
            return;
        const currentContext = selectRelevantShpor(allContext, question);
        const payload = buildShporSavePayload(safeInstanceId, question, answer, category, memoryPayload);
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
        await axios.post(`${platformBaseUrl()}/api/wa/runtime-configs/${encodeURIComponent(safeInstanceId)}/memories`, payload, {
            headers: platformHeaders(),
            timeout: 10000,
        });
        await deleteCache(`shpor_context_100:${safeInstanceId}`);
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
            model: openrouter.chat("openai/gpt-4o-mini"),
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

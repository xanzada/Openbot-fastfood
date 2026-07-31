import { getJsonCache, saveToHistory, setJsonCache } from "./redis.service.js";
import { getOpenRouterProvider, getTextModels } from "./llm.service.js";
const PROFILE_TTL_SECONDS = 60 * 60 * 24 * 180;
const SUMMARY_TTL_SECONDS = 60 * 60 * 24 * 30;
const SUMMARY_REFRESH_EVERY = 6;
export function profileKey(instanceId, phone) {
    return `profile:${instanceId}:${phone}`;
}
export function conversationSummaryKey(instanceId, phone) {
    return `conv_summary:${instanceId}:${phone}`;
}
export async function getCustomerProfile(instanceId, phone) {
    return getJsonCache(profileKey(instanceId, phone)).catch(() => null);
}
export async function getConversationSummary(instanceId, phone) {
    return getJsonCache(conversationSummaryKey(instanceId, phone)).catch(() => null);
}
export async function saveCustomerProfile(instanceId, phone, profile) {
    await setJsonCache(profileKey(instanceId, phone), PROFILE_TTL_SECONDS, {
        ...profile,
        updated_at: new Date().toISOString(),
    }).catch(() => undefined);
}
export async function saveConversationSummary(instanceId, phone, summary) {
    await setJsonCache(conversationSummaryKey(instanceId, phone), SUMMARY_TTL_SECONDS, summary).catch(() => undefined);
}
/**
 * Marks that this customer was seen, without an LLM call. Cheap and always safe.
 */
export async function touchCustomerProfile(instanceId, phone) {
    const existing = (await getCustomerProfile(instanceId, phone)) || {};
    const nowIso = new Date().toISOString();
    const next = {
        ...existing,
        first_seen_at: existing.first_seen_at || nowIso,
        last_seen_at: nowIso,
    };
    await saveCustomerProfile(instanceId, phone, next);
    return next;
}
function historyRoleLabel(entry) {
    const role = String(entry?.role || "").toLowerCase();
    if (["assistant", "model", "bot", "ai", "operator"].includes(role))
        return "business";
    if (entry?.direction === "outgoing" || entry?.fromMe === true)
        return "business";
    return "customer";
}
function transcriptFor(history, limit = 30) {
    return (Array.isArray(history) ? history : [])
        .slice(-limit)
        .map((entry) => `${historyRoleLabel(entry)}: ${String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim().slice(0, 400)}`)
        .filter((line) => line.length > 12)
        .join("\n");
}
function safeJson(raw) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start)
        return null;
    try {
        return JSON.parse(raw.slice(start, end + 1));
    }
    catch {
        return null;
    }
}
function stringList(value, max = 6) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => String(item || "").replace(/\s+/g, " ").trim().slice(0, 120))
        .filter(Boolean)
        .slice(0, max);
}
const MEMORY_SYSTEM_PROMPT = `You maintain the private CRM memory of one restaurant customer.
You are not talking to the customer. You only extract what the customer themselves stated or what demonstrably happened.
Rules:
- Never guess, never infer identity, gender, income, or health.
- Only record a name if the customer wrote it about themselves.
- favorite_items: concrete dishes the customer ordered, praised, or repeatedly asked about.
- allergies: only explicit allergy or intolerance statements - never dietary guesses.
- usual_address: a delivery address the customer themselves gave, shortened to one line.
- preferred_tone: how this person visibly prefers to be spoken to (short, warm, formal), only if their messages show it.
- lessons: at most 2 short notes on what worked or failed in serving this customer (e.g. "answers better in short messages", "was upset about late delivery").
- Preferences and dislikes must be about food, channel, timing, or payment, quoted close to their own words.
- The summary is at most 3 sentences of what matters for serving this person next time.
- open_point is the single unresolved thing from the end of the conversation, or an empty string.
- Answer with JSON only.`;
/**
 * Refreshes profile + summary with one cheap flash-model call.
 *
 * Called fire-and-forget after the reply is delivered. Any failure is swallowed:
 * memory is an enhancement, never a dependency of answering.
 */
export async function refreshCustomerMemory(input) {
    const { instanceId, phone, history, language } = input;
    const messageCount = Array.isArray(history) ? history.length : 0;
    const existingSummary = await getConversationSummary(instanceId, phone);
    const existingProfile = (await getCustomerProfile(instanceId, phone)) || {};
    // Only re-summarize every few messages. Doing it every turn would burn tokens
    // for no new information.
    const since = messageCount - Number(existingSummary?.message_count || 0);
    if (existingSummary && since < SUMMARY_REFRESH_EVERY) {
        await touchCustomerProfile(instanceId, phone);
        return;
    }
    const transcript = transcriptFor(history);
    if (!transcript) {
        await touchCustomerProfile(instanceId, phone);
        return;
    }
    try {
        const provider = getOpenRouterProvider();
        const model = provider.chat(getTextModels().reserve);
        const { generateText } = await import("ai");
        const result = await generateText({
            model: model,
            temperature: 0,
            system: MEMORY_SYSTEM_PROMPT,
            prompt: [
                `reply_language: ${language}`,
                `known_profile: ${JSON.stringify(existingProfile)}`,
                `previous_summary: ${String(existingSummary?.summary || "")}`,
                "conversation:",
                transcript,
                "",
                'Return JSON: {"summary":"","open_point":"","self_introduced_name":"","preferences":[],"avoid":[],"usual_channel":"","notes":[],"favorite_items":[],"allergies":[],"usual_address":"","preferred_tone":"","lessons":[]}',
            ].join("\n"),
        });
        const parsed = safeJson(String(result.text || ""));
        if (!parsed) {
            await touchCustomerProfile(instanceId, phone);
            return;
        }
        const nowIso = new Date().toISOString();
        await saveConversationSummary(instanceId, phone, {
            summary: String(parsed.summary || existingSummary?.summary || "").replace(/\s+/g, " ").trim().slice(0, 700),
            open_point: String(parsed.open_point || "").replace(/\s+/g, " ").trim().slice(0, 200),
            updated_at: nowIso,
            message_count: messageCount,
        });
        await saveCustomerProfile(instanceId, phone, {
            ...existingProfile,
            self_introduced_name: String(parsed.self_introduced_name || existingProfile.self_introduced_name || "").trim().slice(0, 60) || undefined,
            preferences: stringList(parsed.preferences).length ? stringList(parsed.preferences) : existingProfile.preferences,
            avoid: stringList(parsed.avoid).length ? stringList(parsed.avoid) : existingProfile.avoid,
            usual_channel: String(parsed.usual_channel || existingProfile.usual_channel || "").trim().slice(0, 40) || undefined,
            notes: stringList(parsed.notes, 4).length ? stringList(parsed.notes, 4) : existingProfile.notes,
            favorite_items: stringList(parsed.favorite_items, 6).length ? stringList(parsed.favorite_items, 6) : existingProfile.favorite_items,
            allergies: stringList(parsed.allergies, 4).length ? stringList(parsed.allergies, 4) : existingProfile.allergies,
            usual_address: String(parsed.usual_address || existingProfile.usual_address || "").trim().slice(0, 160) || undefined,
            preferred_tone: String(parsed.preferred_tone || existingProfile.preferred_tone || "").trim().slice(0, 60) || undefined,
            lessons: stringList(parsed.lessons, 3).length ? stringList(parsed.lessons, 3) : existingProfile.lessons,
            first_seen_at: existingProfile.first_seen_at || nowIso,
            last_seen_at: nowIso,
        });
        console.info(`[MEMORY] refreshed instance=${instanceId} messages=${messageCount}`);
    }
    catch (error) {
        console.warn(`[MEMORY] refresh_failed instance=${instanceId} reason=${error?.message || error}`);
        await touchCustomerProfile(instanceId, phone).catch(() => undefined);
    }
}
/**
 * Records what the deterministic pipeline did on this turn so the NEXT turn the
 * agent knows what already happened to the customer: which media was analysed,
 * which tools ran, whether the validator rewrote the reply. Without this the
 * agent kept re-asking for information the pipeline had already handled.
 */
export async function recordTurnTrace(input) {
    await setJsonCache(`last_turn:${input.instanceId}:${input.phone}`, 60 * 60 * 6, {
        ...input.trace,
        at: new Date().toISOString(),
    }).catch(() => undefined);
}
export async function getTurnTrace(instanceId, phone) {
    return getJsonCache(`last_turn:${instanceId}:${phone}`).catch(() => null);
}
export { saveToHistory };

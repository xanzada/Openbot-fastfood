import { getJsonCache, saveToHistory, setJsonCache } from "./redis.service.js";
import { getOpenRouterProvider, getTextModels } from "./llm.service.js";

/**
 * Long-term, tenant-scoped memory for a single customer.
 *
 * Before this existed the agent only ever saw the raw tail of the chat list, so
 * anything said more than a few messages ago was gone: preferences, the name the
 * customer introduced themselves with, the fact that they always order pickup,
 * or that the previous conversation ended in a complaint. Every turn started
 * from zero, which is the main reason replies felt like a fresh stranger each
 * time instead of someone who knows this guest.
 *
 * Two artifacts are stored, both derived from data the bot already has, so no
 * new source of truth is introduced and nothing here can override FACTS_CONTEXT:
 *  - profile: durable, slowly-changing facts the customer volunteered.
 *  - summary: a rolling narrative of what happened earlier in this relationship.
 *
 * Both are written AFTER the reply has been sent, so customer latency is
 * unchanged. Both are advisory context, never a factual authority.
 */

export interface CustomerProfile {
  self_introduced_name?: string;
  preferences?: string[];
  avoid?: string[];
  usual_channel?: string;
  notes?: string[];
  order_count?: number;
  complaint_count?: number;
  first_seen_at?: string;
  last_seen_at?: string;
  updated_at?: string;
}

export interface ConversationSummary {
  summary: string;
  open_point?: string;
  updated_at: string;
  message_count: number;
}

const PROFILE_TTL_SECONDS = 60 * 60 * 24 * 180;
const SUMMARY_TTL_SECONDS = 60 * 60 * 24 * 30;
const SUMMARY_REFRESH_EVERY = 6;

export function profileKey(instanceId: string, phone: string) {
  return `profile:${instanceId}:${phone}`;
}

export function conversationSummaryKey(instanceId: string, phone: string) {
  return `conv_summary:${instanceId}:${phone}`;
}

export async function getCustomerProfile(instanceId: string, phone: string): Promise<CustomerProfile | null> {
  return getJsonCache<CustomerProfile>(profileKey(instanceId, phone)).catch(() => null);
}

export async function getConversationSummary(instanceId: string, phone: string): Promise<ConversationSummary | null> {
  return getJsonCache<ConversationSummary>(conversationSummaryKey(instanceId, phone)).catch(() => null);
}

export async function saveCustomerProfile(instanceId: string, phone: string, profile: CustomerProfile): Promise<void> {
  await setJsonCache(profileKey(instanceId, phone), PROFILE_TTL_SECONDS, {
    ...profile,
    updated_at: new Date().toISOString(),
  }).catch(() => undefined);
}

export async function saveConversationSummary(instanceId: string, phone: string, summary: ConversationSummary): Promise<void> {
  await setJsonCache(conversationSummaryKey(instanceId, phone), SUMMARY_TTL_SECONDS, summary).catch(() => undefined);
}

/**
 * Marks that this customer was seen, without an LLM call. Cheap and always safe.
 */
export async function touchCustomerProfile(instanceId: string, phone: string): Promise<CustomerProfile> {
  const existing = (await getCustomerProfile(instanceId, phone)) || {};
  const nowIso = new Date().toISOString();
  const next: CustomerProfile = {
    ...existing,
    first_seen_at: existing.first_seen_at || nowIso,
    last_seen_at: nowIso,
  };
  await saveCustomerProfile(instanceId, phone, next);
  return next;
}

function historyRoleLabel(entry: any): "customer" | "business" {
  const role = String(entry?.role || "").toLowerCase();
  if (["assistant", "model", "bot", "ai", "operator"].includes(role)) return "business";
  if (entry?.direction === "outgoing" || entry?.fromMe === true) return "business";
  return "customer";
}

function transcriptFor(history: any[], limit = 30) {
  return (Array.isArray(history) ? history : [])
    .slice(-limit)
    .map((entry) => `${historyRoleLabel(entry)}: ${String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .filter((line) => line.length > 12)
    .join("\n");
}

function safeJson(raw: string): Record<string, any> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

function stringList(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").replace(/\s+/g, " ").trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, max);
}

const MEMORY_SYSTEM_PROMPT = `You maintain the private CRM memory of one restaurant customer.
You are not talking to the customer. You only extract what the customer themselves stated.
Rules:
- Never guess, never infer identity, gender, income, or health.
- Only record a name if the customer wrote it about themselves.
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
export async function refreshCustomerMemory(input: {
  instanceId: string;
  phone: string;
  history: any[];
  language: "kk" | "ru";
}): Promise<void> {
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
      model: model as any,
      temperature: 0,
      system: MEMORY_SYSTEM_PROMPT,
      prompt: [
        `reply_language: ${language}`,
        `known_profile: ${JSON.stringify(existingProfile)}`,
        `previous_summary: ${String(existingSummary?.summary || "")}`,
        "conversation:",
        transcript,
        "",
        'Return JSON: {"summary":"","open_point":"","self_introduced_name":"","preferences":[],"avoid":[],"usual_channel":"","notes":[]}',
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
      self_introduced_name:
        String(parsed.self_introduced_name || existingProfile.self_introduced_name || "").trim().slice(0, 60) || undefined,
      preferences: stringList(parsed.preferences).length ? stringList(parsed.preferences) : existingProfile.preferences,
      avoid: stringList(parsed.avoid).length ? stringList(parsed.avoid) : existingProfile.avoid,
      usual_channel: String(parsed.usual_channel || existingProfile.usual_channel || "").trim().slice(0, 40) || undefined,
      notes: stringList(parsed.notes, 4).length ? stringList(parsed.notes, 4) : existingProfile.notes,
      first_seen_at: existingProfile.first_seen_at || nowIso,
      last_seen_at: nowIso,
    });

    console.info(`[MEMORY] refreshed instance=${instanceId} messages=${messageCount}`);
  } catch (error: any) {
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
export async function recordTurnTrace(input: {
  instanceId: string;
  phone: string;
  trace: Record<string, unknown>;
}): Promise<void> {
  await setJsonCache(`last_turn:${input.instanceId}:${input.phone}`, 60 * 60 * 6, {
    ...input.trace,
    at: new Date().toISOString(),
  }).catch(() => undefined);
}

export async function getTurnTrace(instanceId: string, phone: string): Promise<Record<string, any> | null> {
  return getJsonCache<Record<string, any>>(`last_turn:${instanceId}:${phone}`).catch(() => null);
}

export { saveToHistory };

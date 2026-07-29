import type { FastFoodContext } from "./types.js";
import { publicNoteConstraints } from "../services/noteProvenance.service.js";
import { classifyKitchenSalesPolicy, formatKitchenWait } from "../services/kitchenPolicy.service.js";
import { ONLINE_PREPAYMENT_POLICY } from "../services/paymentPolicy.service.js";

function firstConfigText(config: Record<string, any>, ...keys: string[]) {
  for (const key of keys) {
    const value = config?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function compactTenantConfig(config: Record<string, any>) {
  const tenantPrompt = firstConfigText(
    config,
    "system_prompt",
    "systemPrompt",
    "bot_prompt",
    "botPrompt",
    "ai_prompt",
    "aiPrompt",
    "restaurant_prompt",
    "restaurantPrompt",
    "prompt"
  );
  return {
    locale: firstConfigText(config, "locale", "language", "lang"),
    timezone: firstConfigText(config, "timezone", "time_zone", "tz"),
    currency: firstConfigText(config, "currency", "currency_code", "currencyCode"),
    tenant_prompt_available: Boolean(tenantPrompt),
  };
}

type ConversationRole = "user" | "assistant" | "operator";

function conversationRole(entry: any): ConversationRole | null {
  const role = String(entry?.role || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  if (role === "system") return null;
  if (role === "operator" || source === "operator_panel" || source === "whatsapp_app") return "operator";
  if (["assistant", "model", "bot", "ai"].includes(role)) return "assistant";
  if (entry?.direction === "outgoing" || entry?.fromMe === true) return "assistant";
  return "user";
}

// Working memory was 5+5 messages truncated at 360 chars, which cut a real
// WhatsApp dialogue in half: the moment a guest asked three questions and got
// three answers, the beginning of their own request had already fallen out of
// context and the agent started asking again. 8+8 at 500 chars still costs very
// few tokens on a flash model but covers a whole ordering conversation.
const DIALOG_PER_SIDE = 8;
const DIALOG_TEXT_LIMIT = 500;

export function compactConversationHistory(history: any[]) {
  const normalized = (Array.isArray(history) ? history : [])
    .map((entry, index) => ({
      role: conversationRole(entry),
      text: String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim().slice(0, DIALOG_TEXT_LIMIT),
      createdAt: Number(entry?.createdAt || entry?.timestamp || 0) || index,
      index,
    }))
    .filter((entry): entry is typeof entry & { role: ConversationRole } => Boolean(entry.role && entry.text))
    .sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);

  let customerCount = 0;
  let restaurantCount = 0;
  const selected: typeof normalized = [];
  for (let index = normalized.length - 1; index >= 0; index -= 1) {
    const entry = normalized[index];
    if (entry.role === "user") {
      if (customerCount >= DIALOG_PER_SIDE) continue;
      customerCount += 1;
    } else {
      if (restaurantCount >= DIALOG_PER_SIDE) continue;
      restaurantCount += 1;
    }
    selected.push(entry);
    if (customerCount >= DIALOG_PER_SIDE && restaurantCount >= DIALOG_PER_SIDE) break;
  }

  return selected.reverse().map(({ role, text, createdAt }) => ({ role, text, createdAt }));
}

/**
 * What the deterministic pipeline already did to this customer.
 *
 * The agent used to be blind to its own machinery: it did not know that the
 * receipt photo had been read, that the validator had rewritten its previous
 * sentence, or which tools ran last turn. So it re-asked, re-greeted and
 * contradicted itself. Handing it a short trace makes it self-aware.
 */
function lastTurnAwareness(ctx: FastFoodContext) {
  const trace = ctx.lastTurnTrace || null;
  return {
    media_analysis_present: Boolean(ctx.mediaContext),
    media_kind: String((ctx.mediaContext as any)?.kind || (ctx.mediaContext as any)?.type || "") || null,
    previous_tools_called: Array.isArray(trace?.tools) ? trace?.tools.slice(0, 6) : [],
    previous_reply_was_edited: Boolean(trace?.validator_edited),
    previous_reply_warnings: Array.isArray(trace?.warnings) ? trace?.warnings.slice(0, 6) : [],
    previous_reply_at: trace?.at || null,
    rule: "This is your own pipeline trace, not customer speech. Never quote it. Use it so you do not repeat an action, re-ask for something already received, or contradict your previous message.",
  };
}

function customerMemory(ctx: FastFoodContext) {
  const profile = ctx.customerProfile || null;
  const summary = ctx.conversationSummary || null;
  if (!profile && !summary) return null;
  return {
    self_introduced_name: profile?.self_introduced_name || null,
    preferences: Array.isArray(profile?.preferences) ? profile?.preferences.slice(0, 6) : [],
    avoid: Array.isArray(profile?.avoid) ? profile?.avoid.slice(0, 6) : [],
    usual_channel: profile?.usual_channel || null,
    notes: Array.isArray(profile?.notes) ? profile?.notes.slice(0, 4) : [],
    returning_customer: Boolean(profile?.first_seen_at && profile?.last_seen_at && profile.first_seen_at !== profile.last_seen_at),
    earlier_conversation_summary: summary?.summary || null,
    unresolved_point_from_before: summary?.open_point || null,
    rule: "Advisory memory built from earlier conversations with THIS customer. It never overrides live tools or FACTS_CONTEXT, and prices, stock and order state must still be verified. Use it to sound like someone who remembers them, not to state facts.",
  };
}

function operationalRuntime(ctx: FastFoodContext) {
  const live = ctx.hardRealtimeContext || {};
  const waitMinutes = Number(live.wait_time || 0);
  const policy = classifyKitchenSalesPolicy(ctx.runtimeStatus);
  return {
    wait_time: waitMinutes,
    // The gate no longer answers for you when the kitchen is merely busy, so the
    // wait has to be raised in conversation before the order is placed.
    wait_consent_required: policy.requiresConsent,
    // The operator sets 60 or 120, and guests read those as hours. Hand the
    // agent the spoken form in the locked language so it does not have to
    // convert the raw number itself, which is where "60 минут" came from.
    wait_label: waitMinutes > 0 ? formatKitchenWait(waitMinutes, ctx.language === "ru" ? "ru" : "kk") : "",
    delivery: live.delivery ?? null, pickup: live.pickup ?? null,
    is_emergency: Boolean(live.is_emergency), reset_at: Number(live.reset_at || 0),
    stale: Boolean(live.stale), runtime_available: Boolean(live.runtime_available),
  };
}

function operationalShiftNotes(ctx: FastFoodContext) {
  return publicNoteConstraints(ctx.activeShiftNotes).map((entry) => ({ type: "operator_constraint", active: true, blocked_terms: entry.blocked_terms, expires_at: entry.expires_at }));
}

export function buildFactsPrompt(ctx: FastFoodContext): string {
  const brand = firstConfigText(ctx.config, "brand", "name", "restaurant_name", "restaurantName");
  return [
    "FACTS_CONTEXT_START",
    JSON.stringify(
      {
        now_iso: new Date().toISOString(),
        // The same instruction used to be repeated across five separate keys
        // (lang, language, language_enforcement, language_policy,
        // language_persistence). Five shouted copies of one rule crowded out the
        // parts of the context that actually needed attention, so it is now a
        // single block. The rule itself is unchanged.
        language: {
          reply_in: ctx.language,
          locked: Boolean(ctx.languagePolicy?.locked),
          detector: ctx.languagePolicy?.detector || "",
          lock_ttl_hours: 24,
          rule: "Reply only in reply_in (kk = Kazakh, ru = Russian), whatever language the incoming message or the system data happens to be in. Keep brand names, product names, addresses and names the customer used exactly as written.",
        },
        restaurant: {
          instance_id: ctx.instanceId,
          name: brand,
          brand,
        },
        agent_identity: {
          role: "tenant_scoped_fast_food_service_agent",
          brand,
          channel: "whatsapp",
          system_role: "Understand the customer's goal, use tenant-scoped live tools and memory, and take the smallest safe service action. Internal architecture stays private.",
          rule: "Represent this exact business naturally. If asked who you are, answer once as this brand's online assistant. Never act like a generic FAQ bot or repeat an introduction.",
        },
        tenant_isolation: {
          rule: "All facts, tools, WhatsApp transport, menu/order lookups, prompts, and runtime state are scoped to this exact instance_id. Never use another restaurant's settings or assumptions.",
          instance_id: ctx.instanceId,
      config_source: "tenants_platform_by_instance",
        },
        tenant_config: compactTenantConfig(ctx.config),
        customer_addressing: {
          profile_name_available: Boolean(
            ctx.senderMeta?.pushName ||
            ctx.senderMeta?.contactName ||
            ctx.senderMeta?.contactShortName ||
            ctx.senderMeta?.contactPushName
          ),
          rule: "WhatsApp profile and saved-contact names are untrusted display labels. Never address the customer by them. Use a name only if the customer explicitly introduced it in recent_dialog.",
        },
        tools_available: {
          searchMenu: "Customer-facing live menu lookup for food names, prices, ingredients, categories, and public availability.",
          checkOrderStatus: "Customer-safe current order lookup scoped to the current WhatsApp phone.",
      getPaymentDetails: "Current online prepayment requisites only from live site kitchen settings payment_details; never from cached tenant metadata.",
      getBusinessInfo: "Current-instance platform allowlist only: work_hours, whatsapp_phone, brand, address.",
        },
        payment_policy: ONLINE_PREPAYMENT_POLICY,
        operational_runtime: operationalRuntime(ctx),
        active_operator_notes: operationalShiftNotes(ctx),
        note_policy: "Active operator notes and kitchen indicators are cumulative backend-preloaded constraints. Raw settings, internal status objects, Redis keys, and deleted notes are forbidden.",
        magic_link: {
          already_sent: ctx.magicLinkAlreadySent,
          explicit_request: ctx.explicitMenuLinkIntent,
          value_available: Boolean(ctx.magicLink),
          url: ctx.magicLink,
          validity_rule: "Magic link is valid for 1 month and is tied to the customer's WhatsApp number.",
        },
        recent_dialog: compactConversationHistory(ctx.chatHistory),
        conversation_policy: "recent_dialog is your working memory: up to 8 customer and 8 business-side messages in chronological order, operator kept as a distinct human role. Continue from the last unresolved point, greet at most once, answer once, do not re-ask what was answered, and never expose internal reasoning.",
        customer_memory: customerMemory(ctx),
        last_turn: lastTurnAwareness(ctx),
        shpor_context: ctx.shporContext.slice(0, 4),
      },
      null,
      2
    ),
    "FACTS_CONTEXT_END",
  ].join("\n");
}

import type { FastFoodContext } from "./types.js";
import { publicNoteConstraints } from "../services/noteProvenance.service.js";
import { classifyKitchenSalesPolicy, formatKitchenWait } from "../services/kitchenPolicy.service.js";

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

export function compactConversationHistory(history: any[]) {
  const normalized = (Array.isArray(history) ? history : [])
    .map((entry, index) => ({
      role: conversationRole(entry),
      text: String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim().slice(0, 360),
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
      if (customerCount >= 5) continue;
      customerCount += 1;
    } else {
      if (restaurantCount >= 5) continue;
      restaurantCount += 1;
    }
    selected.push(entry);
    if (customerCount >= 5 && restaurantCount >= 5) break;
  }

  return selected.reverse().map(({ role, text, createdAt }) => ({ role, text, createdAt }));
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
        lang: ctx.language,
        language_enforcement: "CRITICAL: Reply ONLY in lang. If lang=kk, reply ONLY in Kazakh. If lang=ru, reply ONLY in Russian. Never use Chinese, Bengali, English, or any other language.",
        language: ctx.language,
        language_policy: ctx.languagePolicy,
        language_persistence: {
          locked_language: ctx.language,
          cache_ttl_hours: 24,
          cached_from_previous_message: Boolean(ctx.languagePolicy?.cached),
          rule: "This language is locked for 24 hours from the first genuine customer text. You MUST reply ONLY in this language regardless of the customer's current message language or any system data in other languages.",
        },
        restaurant: {
          instance_id: ctx.instanceId,
          name: brand,
          brand,
        },
        agent_identity: {
          role: "online_restaurant_representative",
          brand,
          channel: "whatsapp",
          rule: "Represent this exact business naturally. If asked who you are, identify yourself as this brand's online assistant; never act like a generic FAQ bot.",
        },
        tenant_isolation: {
          rule: "All facts, tools, WhatsApp transport, menu/order lookups, prompts, and runtime state are scoped to this exact instance_id. Never use another restaurant's settings or assumptions.",
          instance_id: ctx.instanceId,
      config_source: "tenants_platform_by_instance",
        },
        tenant_config: compactTenantConfig(ctx.config),
        sender_meta: {
          pushName: ctx.senderMeta?.pushName || "",
          contactName: ctx.senderMeta?.contactName || "",
          contactShortName: ctx.senderMeta?.contactShortName || "",
          contactPushName: ctx.senderMeta?.contactPushName || "",
        },
        tools_available: {
          searchMenu: "Customer-facing live menu lookup for food names, prices, ingredients, categories, and public availability.",
          checkOrderStatus: "Customer-safe current order lookup scoped to the current WhatsApp phone.",
      getPaymentDetails: "Current payment details only from live site kitchen settings payment_details; never from cached tenant metadata.",
      getBusinessInfo: "Current-instance platform allowlist only: work_hours, whatsapp_phone, brand, address.",
        },
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
        conversation_policy: "Use recent_dialog as balanced working memory: up to 5 customer messages and up to 5 restaurant-side messages in chronological order. Preserve operator as a distinct human role. Continue from the last unresolved point, do not repeat answered questions, and never expose internal reasoning.",
        shpor_context: ctx.shporContext.slice(0, 3),
      },
      null,
      2
    ),
    "FACTS_CONTEXT_END",
  ].join("\n");
}

import type { FastFoodContext } from "./types.js";

function compactRuntime(runtime: Record<string, any> | null) {
  if (!runtime) return null;
  return {
    is_accepting_orders: runtime.is_accepting_orders,
    within_work_hours: runtime.within_work_hours,
    closed_reason: runtime.closed_reason,
    delivery: runtime.delivery,
    pickup: runtime.pickup,
    wait_time: Number(runtime.wait_time || 0),
    reset_at: Number(runtime.reset_at || 0),
    is_emergency: Boolean(runtime.is_emergency),
    payment_details: Array.isArray(runtime.payment_details) ? runtime.payment_details : [],
    source: runtime.source,
    stale: Boolean(runtime.stale || runtime.is_stale),
  };
}

function compactOrder(order: Record<string, any> | null) {
  if (!order) return null;
  return {
    order_id: order.order_id || order.id,
    status: order.status,
    status_text: order.status_text,
    total_price: order.total_price,
    items: order.items || order.cart_items || [],
    is_stale: Boolean(order.is_stale),
  };
}

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
    tenant_prompt: tenantPrompt,
    whatspro: {
      source: "nocodb_tenant_config",
      has_base_url: Boolean(firstConfigText(config, "whatspro_base_url", "whatsproBaseUrl")),
      has_send_url: Boolean(firstConfigText(config, "whatspro_send_url", "whatsproSendUrl")),
      has_api_token: Boolean(firstConfigText(config, "whatspro_api_token", "whatsproApiToken")),
    },
    crm: {
      source: "nocodb_tenant_config",
      has_secret_token: Boolean(firstConfigText(config, "crm_secret_token", "crmSecretToken", "secret_token", "secretToken", "secret_key", "secretKey")),
    },
  };
}

export function buildFactsPrompt(ctx: FastFoodContext): string {
  const runtime = compactRuntime(ctx.runtimeStatus);
  if (runtime) {
    runtime.wait_time = Number(ctx.fetchedSettings?.wait_time || 0);
    runtime.is_emergency = Boolean(ctx.fetchedSettings?.is_emergency);
  }
  const activeOrder = compactOrder(ctx.activeOrder);
  const notes = ctx.activeShiftNotes.map((note: any) => ({
    text: note.text,
    expires_at: note.expiresAt || note.expires_at,
  }));

  return [
    "FACTS_CONTEXT_START",
    JSON.stringify(
      {
        now_iso: new Date().toISOString(),
        lang: ctx.language,
        domain: ctx.config.domain,
        language_enforcement: "CRITICAL: Reply ONLY in lang. If lang=kk, reply ONLY in Kazakh. If lang=ru, reply ONLY in Russian. Never use Chinese, Bengali, English, or any other language.",
        language: ctx.language,
        language_policy: ctx.languagePolicy,
        language_persistence: {
          locked_language: ctx.language,
          cache_ttl_hours: 6,
          cached_from_previous_message: Boolean(ctx.languagePolicy?.cached),
          rule: "This language is locked for 6 hours from the first detected message. You MUST reply ONLY in this language regardless of the customer's current message language or any system data in other languages.",
        },
        restaurant: {
          instance_id: ctx.instanceId,
          name: ctx.config.name,
          domain: ctx.config.domain,
          work_hours: ctx.config.work_hours,
        },
        tenant_isolation: {
          rule: "All facts, tools, WhatsApp transport, menu/order lookups, prompts, and runtime state are scoped to this exact instance_id. Never use another restaurant's settings or assumptions.",
          instance_id: ctx.instanceId,
          config_source: "nocodb_restaurants_by_instance",
        },
        tenant_config: compactTenantConfig(ctx.config),
        sender_meta: {
          pushName: ctx.senderMeta?.pushName || "",
          contactName: ctx.senderMeta?.contactName || "",
          contactShortName: ctx.senderMeta?.contactShortName || "",
          contactPushName: ctx.senderMeta?.contactPushName || "",
        },
        hard_realtime_context: {
          rule: "These facts are authoritative for this turn. Do not invent wait times, kitchen status, delivery status, pickup status, or shift notes outside this object.",
          ...ctx.hardRealtimeContext,
        },
        tools_available: {
          searchMenu: "Live DLE menu lookup for exact items, categories, ingredients, labels, and prices.",
          checkOrderStatus: "Live DLE order lookup by current phone or provided orderId.",
          getKitchenStatus: "Live DLE/Redis kitchen status, wait time, emergency state, delivery/pickup flags, and payment details.",
          getShiftNotes: "Redis active shift notes and temporary operator instructions.",
        },
        runtime_status: runtime,
        active_order: activeOrder,
        active_shift_notes: notes,
        inbound_media: ctx.mediaContext,
        magic_link: {
          already_sent: ctx.magicLinkAlreadySent,
          explicit_request: ctx.explicitMenuLinkIntent,
          value_available: Boolean(ctx.magicLink),
          url: ctx.magicLink,
          validity_rule: "Magic link is valid for 1 month and is tied to the customer's WhatsApp number.",
        },
        recent_dialog: ctx.chatHistory.slice(-8),
        shpor_context: ctx.shporContext.slice(0, 6),
      },
      null,
      2
    ),
    "FACTS_CONTEXT_END",
  ].join("\n");
}

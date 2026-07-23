function firstConfigText(config, ...keys) {
    for (const key of keys) {
        const value = config?.[key];
        if (value !== undefined && value !== null && String(value).trim())
            return String(value).trim();
    }
    return "";
}
function compactTenantConfig(config) {
    const tenantPrompt = firstConfigText(config, "system_prompt", "systemPrompt", "bot_prompt", "botPrompt", "ai_prompt", "aiPrompt", "restaurant_prompt", "restaurantPrompt", "prompt");
    return {
        locale: firstConfigText(config, "locale", "language", "lang"),
        timezone: firstConfigText(config, "timezone", "time_zone", "tz"),
        currency: firstConfigText(config, "currency", "currency_code", "currencyCode"),
        tenant_prompt_available: Boolean(tenantPrompt),
    };
}
function compactHistory(history) {
    return history.slice(-4).map((entry) => ({
        role: entry?.role === "assistant" ? "assistant" : "user",
        text: String(entry?.text || "").slice(0, 500),
    }));
}
export function buildFactsPrompt(ctx) {
    return [
        "FACTS_CONTEXT_START",
        JSON.stringify({
            now_iso: new Date().toISOString(),
            lang: ctx.language,
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
            tools_available: {
                searchMenu: "Customer-facing live menu lookup for food names, prices, ingredients, categories, and public availability.",
                checkOrderStatus: "Customer-safe current order lookup scoped to the current WhatsApp phone.",
                getPaymentDetails: "Current customer-facing payment details.",
            },
            magic_link: {
                already_sent: ctx.magicLinkAlreadySent,
                explicit_request: ctx.explicitMenuLinkIntent,
                value_available: Boolean(ctx.magicLink),
                url: ctx.magicLink,
                validity_rule: "Magic link is valid for 1 month and is tied to the customer's WhatsApp number.",
            },
            recent_dialog: compactHistory(ctx.chatHistory),
            shpor_context: ctx.shporContext.slice(0, 3),
        }, null, 2),
        "FACTS_CONTEXT_END",
    ].join("\n");
}

function firstConfigText(config, ...keys) {
    for (const key of keys) {
        const value = config?.[key];
        if (value !== undefined && value !== null && String(value).trim())
            return String(value).trim();
    }
    return "";
}
export function buildTenantInstructionsFromConfig(config, instanceId = "") {
    const prompt = firstConfigText(config, "system_prompt", "systemPrompt", "bot_prompt", "botPrompt", "ai_prompt", "aiPrompt", "restaurant_prompt", "restaurantPrompt", "prompt");
    if (!prompt)
        return "";
    return [
        "TENANT_INSTRUCTIONS_START",
        `instance_id: ${instanceId}`,
        "These instructions come from the NocoDB Restaurants row for this exact instance only.",
        prompt,
        "TENANT_INSTRUCTIONS_END",
    ].join("\n");
}
export function buildTenantInstructions(ctx) {
    return buildTenantInstructionsFromConfig(ctx.config, ctx.instanceId);
}

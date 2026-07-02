import axios from "axios";
function pickWebhookUrl(config = {}) {
    return String(config.n8n_webhook_url ||
        config.n8nWebhookUrl ||
        config.kanban_webhook_url ||
        config.kanbanWebhookUrl ||
        process.env.N8N_WEBHOOK_URL ||
        "").trim();
}
export async function syncKanbanEvent(ctx, event) {
    const url = pickWebhookUrl(ctx.config);
    if (!url)
        return { skipped: true };
    const payload = {
        token: process.env.N8N_WEBHOOK_TOKEN || process.env.CRM_SECRET_TOKEN,
        instance: ctx.instanceId,
        instanceId: ctx.instanceId,
        phone: ctx.phone,
        event: event.event || "openbot_inbound",
        source: "openbot-agent",
        created_at: new Date().toISOString(),
        ...event,
    };
    try {
        const response = await axios.post(url, payload, {
            timeout: Number(process.env.N8N_WEBHOOK_TIMEOUT_MS || 5000),
            maxRedirects: 0,
        });
        return { ok: true, status: response.status };
    }
    catch (error) {
        console.warn(`[OPENBOT:KANBAN:SKIP] instance=${ctx.instanceId} status=${error?.response?.status || "-"} error=${error?.message || error}`);
        return { ok: false, status: error?.response?.status };
    }
}

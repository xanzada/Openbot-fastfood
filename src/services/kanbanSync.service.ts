import axios from "axios";
import type { FastFoodContext } from "../context/types.js";
import { envNumber } from "../utils/envNumber.js";

function pickWebhookUrl(config: Record<string, any> = {}) {
  return String(
    config.n8n_webhook_url ||
      config.n8nWebhookUrl ||
      config.kanban_webhook_url ||
      config.kanbanWebhookUrl ||
      ""
  ).trim();
}

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

export async function syncKanbanEvent(
  ctx: FastFoodContext,
  event: Record<string, any>
): Promise<{ skipped?: boolean; ok?: boolean; status?: number }> {
  const url = pickWebhookUrl(ctx.config);
  if (!url) return { skipped: true };

  const payload = {
    token: firstValue(
      ctx.config.n8n_webhook_token,
      ctx.config.n8nWebhookToken,
      ctx.config.crm_secret_token,
      ctx.config.secret_token,
      ctx.config.secret_key,
      ctx.config.n8n_token,
      ctx.config.n8nToken
    ),
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
      timeout: envNumber(process.env.N8N_WEBHOOK_TIMEOUT_MS, 5000, { min: 1000 }),
      maxRedirects: 0,
    });
    return { ok: true, status: response.status };
  } catch (error: any) {
    console.warn(
      `[OPENBOT:KANBAN:SKIP] instance=${ctx.instanceId} status=${error?.response?.status || "-"} error=${error?.message || error}`
    );
    return { ok: false, status: error?.response?.status };
  }
}

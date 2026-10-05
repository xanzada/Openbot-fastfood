import {getRestaurantConfig} from "./platformConfig.service.js";
import {reportOperatorSos} from "./alemiApi.service.js";
import {sendWhatsProMessage} from "../transport/whatspro.client.js";
import {redisClient} from "./redis.service.js";
import {
  queueDurableNotification, deliverDurableNotification, guardedAdminRecipient, redisNotificationStore, normalizeNotificationPhone,
  type NotificationStore, type NotificationRecord,
} from "./durableNotification.service.js";
export interface OperatorNotification {
  instanceId: string; phone: string; caseId: string; signalId: string; kind: string;
  summary: string; source?: string; orderNumber?: string; createdAt?: number;
}
const pendingIndex = (instance: string) => `operator_notification_pending:${instance}`;
export const operatorNotificationKey = (instance: string, caseId: string, channel: "hub" | "admin") =>
  `operator_notification:${instance}:${caseId}:${channel}`;
export function shouldPlanOperatorNotification(input: OperatorNotification) {
  return !(input.kind === "unresolved" && input.source === "ai_unavailable");
}
function safeSummary(value: unknown) {
  return String(value || "").replace(/Bearer\s+\S+/gi, "[скрыто]")
    .replace(/(?:https?:\/\/\S+|\+?\d[\d\s()-]{8,}\d)/gi, "[скрыто]")
    .replace(/(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S+/gi, "[скрыто]")
    .replace(/[\r\n\t]+/g, " ").slice(0, 500);
}
export function buildOperatorNotificationText(input: OperatorNotification) {
  const customer = String(input.phone || "").replace(/\D/g, "");
  return ["Оператор қажет / Нужен оператор", `Клиент: ***${customer.slice(-2)}`,
    `Случай: ${input.caseId}`, `Категория: ${input.kind}`,
    input.orderNumber && input.orderNumber !== "not_found" ? `Заказ: ${safeSummary(input.orderNumber)}` : "",
    `Описание: ${safeSummary(input.summary)}`, "Откройте SOS в WhatsPro для переписки и файлов."].filter(Boolean).join("\n");
}
type OperatorDeps = {
  store?: NotificationStore;
  loadConfig?: (instance: string) => Promise<Record<string, any> | null>;
  send?: typeof sendWhatsProMessage;
  sendHub?: typeof reportOperatorSos;
  legacyHubSent?: (input: OperatorNotification) => Promise<boolean>;
  markLegacyHubSent?: (input: OperatorNotification) => Promise<void>;
  log?: (event: string, record: NotificationRecord) => void;
};
/** Persists both delivery plans BEFORE the guest reply. Does no network or WhatsApp send. */
export async function queueOperatorCaseNotifications(input: OperatorNotification, now = Date.now(), store: NotificationStore = redisNotificationStore) {
  if (!shouldPlanOperatorNotification(input)) return [];
  return Promise.all((["hub", "admin"] as const).map(channel => queueDurableNotification({
    key: operatorNotificationKey(input.instanceId, input.caseId, channel), index: pendingIndex(input.instanceId),
    instanceId: input.instanceId, payload: {...input, channel, createdAt: input.createdAt || now}, now, store,
  })));
}
export async function drainOperatorNotifications(configs: Record<string, any>[], now = Date.now(), deps: OperatorDeps = {}) {
  const store = deps.store || redisNotificationStore;
  const results: Array<{instance: string; key?: string; status: string}> = [];
  for (const summary of configs) {
    const instanceId = String(summary.instance_id || summary.instance || "");
    if (!instanceId) continue;
    try {
      const keys = await store.due(pendingIndex(instanceId), now, 20);
      for (const key of keys) {
        try {
          const queued = await store.get(key);
          if (!queued || queued.instance_id !== instanceId || !key.startsWith(`operator_notification:${instanceId}:`)) {
            await store.quarantine?.(pendingIndex(instanceId), key, now);
            throw new Error("OPERATOR_NOTIFICATION_SCOPE_MISMATCH");
          }
          const args = queued.payload as OperatorNotification & {channel: string};
          const channel = args.channel;
          if (!["hub", "admin"].includes(channel) || args.instanceId !== instanceId
            || typeof args.caseId !== "string" || !/^[A-Za-z0-9_-]{1,96}$/.test(args.caseId)
            || key !== operatorNotificationKey(instanceId, args.caseId, channel as "hub" | "admin")
            || !normalizeNotificationPhone(args.phone) || normalizeNotificationPhone(args.phone) !== args.phone) {
            await store.quarantine?.(pendingIndex(instanceId), key, now);
            throw new Error("OPERATOR_NOTIFICATION_SCOPE_MISMATCH");
          }
          let config: Record<string, any> | null = null;
          const load = async () => {
            config ||= await (deps.loadConfig || ((id: string) => getRestaurantConfig(id, {forceRefresh: true})))(instanceId);
            if (!config || String(config.instance_id || config.instance || "") !== instanceId) throw new Error("TENANT_CONFIG_MISMATCH");
            return config;
          };
          const row = await deliverDurableNotification({
            key, index: pendingIndex(instanceId), instanceId, now, store,
            retryDelaysMs: [2_000, 5_000, 10_000, 30_000],
            prepare: async record => {
              if (channel === "hub") return {recipient: "hub", text: "operator.sos.raised", payload: record!.payload};
              const current = await load();
              return {recipient: guardedAdminRecipient(current, [args.phone]), text: buildOperatorNotificationText(args), payload: record!.payload};
            },
            validate: async record => {
              if (!shouldPlanOperatorNotification(args)) throw new Error("TECHNICAL_CASE_NOT_OPERATOR_INCIDENT");
              if (channel === "admin" && guardedAdminRecipient(await load(), [args.phone]) !== record.recipient) throw new Error("ADMIN_RECIPIENT_CHANGED");
            },
            send: async (record, requestId) => {
              if (channel === "hub") {
                // Preserve the existing accepted-marker contract during rollout.
                const wasSent = deps.legacyHubSent ? await deps.legacyHubSent(args) : Boolean(await redisClient.get(`sos_hub_sent:${instanceId}:${args.caseId}`));
                if (!wasSent) {
                  await (deps.sendHub || reportOperatorSos)(args);
                  if (deps.markLegacyHubSent) await deps.markLegacyHubSent(args);
                  else await redisClient.setEx(`sos_hub_sent:${instanceId}:${args.caseId}`, 7 * 24 * 60 * 60, args.signalId);
                }
                return true;
              }
              const sent = await (deps.send || sendWhatsProMessage)({instanceId, phone: record.recipient, text: record.text, requestId});
              return "acknowledged" in sent && sent.acknowledged === true && sent.queued !== true;
            },
            log: deps.log || ((event, record) => console.log(`[SOS_DELIVERY] ${event} instance=${instanceId} case=${args.caseId} channel=${channel} attempts=${record.attempts} recipient=${channel === "hub" ? "hub" : "***" + record.recipient.slice(-2)} error=${record.last_error || "-"}`)),
          });
          results.push({instance: instanceId, key, status: row?.status || "locked"});
        } catch { results.push({instance: instanceId, key, status: "failed"}); }
      }
    } catch { results.push({instance: instanceId, status: "failed"}); }
  }
  return results;
}


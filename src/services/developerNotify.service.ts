import crypto from "node:crypto";
import { getAllRestaurantConfigs, getRestaurantConfig } from "./platformConfig.service.js";
import { redisClient } from "./redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { envNumber } from "../utils/envNumber.js";

const ALERT_DEDUPE_SECONDS = envNumber(process.env.OPENBOT_DEV_ALERT_DEDUPE_SECONDS, 60, { min: 10 });
// A boot dependency failure repeats identically on every container restart, and a
// 60-second window let the same 401 page the developer again and again all day
// (audit, 2026-08-13). Startup alarms are collapsed into one message per problem
// per window instead.
const BOOT_ALERT_DEDUPE_SECONDS = envNumber(process.env.OPENBOT_BOOT_ALERT_DEDUPE_SECONDS, 6 * 60 * 60, { min: 60 });
const BOOT_ALERT_SCOPES = ["startup_dependency", "startup_diagnostics"];
const localDedupe = new Map<string, number>();

function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function isDisabledTenant(config: Record<string, any> | null | undefined) {
  return ["false", "0", "no", "off"].includes(String(config?.bot_enabled ?? "").trim().toLowerCase());
}

// Every alarm is addressed to the developer phone of the tenant and to nobody else.
// A guest phone (whatsapp_phone, admin_phone, the customer in meta) must never be a
// destination: an internal incident text in a guest chat is a support failure, not a
// notification (audit, 2026-08-13).
function isCustomerPhone(
  config: Record<string, any> | null | undefined,
  phone: string,
  meta: Record<string, unknown> = {}
) {
  const guestNumbers = [
    config?.whatsapp_phone,
    config?.admin_phone,
    config?.wa_phone,
    meta.customerPhone,
    meta.customer_phone,
    meta.phone,
  ]
    .map((value) => normalizePhone(value))
    .filter(Boolean);
  return guestNumbers.includes(phone);
}

export const developerAlertInternals = { isDisabledTenant, isCustomerPhone, buildAlertText };

function cleanAlertText(value: unknown, max = 600) {
  const text = String(value ?? "unknown_error")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:token|secret|key|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (text || "unknown_error").slice(0, max);
}

function errorMessage(error: unknown) {
  return cleanAlertText(error instanceof Error ? error.message : error);
}

function errorCode(error: unknown) {
  const value = error && typeof error === "object" ? (error as any).code || (error as any).name : "";
  return cleanAlertText(value || "ERROR", 80);
}

function alertFingerprint(instanceId: string, error: unknown, meta: Record<string, unknown>) {
  return crypto
    .createHash("sha256")
    .update(`${instanceId}|${String(meta.scope || "unknown")}|${errorCode(error)}|${errorMessage(error)}`)
    .digest("hex")
    .slice(0, 20);
}

async function claimAlert(fingerprint: string, ttlSeconds = ALERT_DEDUPE_SECONDS): Promise<boolean> {
  const now = Date.now();
  for (const [key, expiresAt] of localDedupe) {
    if (expiresAt <= now) localDedupe.delete(key);
  }
  if ((localDedupe.get(fingerprint) || 0) > now) return false;
  localDedupe.set(fingerprint, now + ttlSeconds * 1000);

  if (!redisClient.isOpen) return true;
  try {
    const result = await redisClient.set(`dev_alert:${fingerprint}`, "1", {
      NX: true,
      EX: ttlSeconds,
    });
    return result === "OK";
  } catch {
    return true;
  }
}

function metaLines(meta: Record<string, unknown>) {
  const allowed: Array<[string, string]> = [
    ["Action", "action"],
    ["Order", "orderId"],
    ["Message ID", "messageId"],
    ["Customer", "customerPhone"],
    ["Dependency", "dependency"],
    ["Status", "status"],
  ];
  return allowed
    .map(([label, key]) => (meta[key] === undefined || meta[key] === "" ? "" : `${label}: ${cleanAlertText(meta[key], 160)}`))
    .filter(Boolean);
}

function alertKind(meta: Record<string, unknown>) {
  const scope = String(meta.scope || "").trim();
  if (scope === "daily_analytics" || scope === "daily_analytics_fatal") return "Фондық тапсырма ақауы";
  if (scope === "startup_dependency" || scope === "startup_diagnostics") return "Іске қосу диагностикасы";
  if (scope === "uncaught_exception" || scope === "unhandled_rejection" || scope === "http_server") {
    return "Процесс ақауы";
  }
  return "Жүйелік ақау";
}

function buildAlertText(
  instanceId: string,
  error: unknown,
  meta: Record<string, unknown>,
  incidentId: string,
  occurredAt = new Date()
) {
  return [
    "⚠️ OPENBOT АҚАУЫ",
    `Instance: ${instanceId}`,
    `Түрі: ${alertKind(meta)}`,
    `Бөлім: ${cleanAlertText(meta.scope || "unknown", 120)}`,
    `Қате: ${errorCode(error)} — ${errorMessage(error)}`,
    ...metaLines(meta),
    `Уақыт: ${occurredAt.toISOString()}`,
    `Incident: ${incidentId}`,
    meta.restartOccurred === true ? "Қайта іске қосу: расталды." : "",
  ].filter(Boolean).join("\n");
}

async function persistDeveloperAlertOutbox(instanceId: string, incidentId: string, text: string, sendError: unknown) {
  if (!redisClient.isOpen) return false;
  try {
    const payload = JSON.stringify({ instanceId, incidentId, text, error: errorMessage(sendError), failedAt: Date.now(), channel: "whatspro" });
    await redisClient.multi()
      .setEx(`dev_alert_outbox:${instanceId}:${incidentId}`, 7 * 24 * 60 * 60, payload)
      .zAdd(`dev_alert_outbox:${instanceId}`, [{ score: Date.now(), value: incidentId }])
      .expire(`dev_alert_outbox:${instanceId}`, 7 * 24 * 60 * 60)
      .exec();
    return true;
  } catch { return false; }
}

// The outbox existed but nothing ever read it: every alert that failed to send was
// "persisted for retry" and then sat there until its 7-day TTL expired, while the keys
// and the ZSET accumulated (found 2026-08-22). Either drain it or stop pretending -
// draining is the useful half, because the alerts that fail are exactly the ones about
// a broken WhatsPro, which usually recovers minutes later.
const DEV_ALERT_RETRY_LIMIT = Number(process.env.DEV_ALERT_RETRY_LIMIT || 20);

// Draining on every 45s tick with no brake turned that fix into a retry storm: a tenant
// whose WhatsApp session is unpaired can never accept the send, so every tick re-sent
// all of its pending entries and logged a 503 for each one - 53 failures in 20 minutes,
// all from one inactive tenant (regression of the drain added the same day, measured
// live 2026-08-22). Three independent brakes, because each one alone still leaves a way
// to loop forever:
//   1. an inactive tenant is never retried - it has no session to receive anything;
//   2. an entry is abandoned after DEV_ALERT_MAX_ATTEMPTS tries, so a permanently
//      undeliverable alert cannot be retried for the whole 7 days of its TTL;
//   3. after a failed pass the tenant is not retried for DEV_ALERT_DRAIN_COOLDOWN_MS,
//      so an outage costs one attempt per cooldown instead of one per tick.
const DEV_ALERT_MAX_ATTEMPTS = envNumber(process.env.DEV_ALERT_MAX_ATTEMPTS, 5, { min: 1 });
const DEV_ALERT_DRAIN_COOLDOWN_MS = envNumber(
  process.env.DEV_ALERT_DRAIN_COOLDOWN_MS,
  15 * 60 * 1000,
  { min: 1_000 }
);
const DEV_ALERT_OUTBOX_TTL_SECONDS = 7 * 24 * 60 * 60;
const drainBlockedUntil = new Map<string, number>();

// The attempt count lives inside the entry, not in a counter here: this process is
// restarted by exactly the failures that fill the outbox, and an in-memory counter
// would reset every time and never reach the limit.
function shouldAbandonAlert(attempts: unknown) {
  return Number(attempts || 0) >= DEV_ALERT_MAX_ATTEMPTS;
}

function isDrainOnCooldown(instanceId: string, now = Date.now()) {
  return (drainBlockedUntil.get(instanceId) || 0) > now;
}

function noteDrainFailure(instanceId: string, now = Date.now()) {
  drainBlockedUntil.set(instanceId, now + DEV_ALERT_DRAIN_COOLDOWN_MS);
}

function noteDrainHealthy(instanceId: string) {
  drainBlockedUntil.delete(instanceId);
}

// Exported for the regression tests so they drive the same predicates the drain uses,
// rather than a copy of them.
export const developerAlertDrainInternals = {
  shouldAbandonAlert,
  isDrainOnCooldown,
  noteDrainFailure,
  noteDrainHealthy,
  maxAttempts: () => DEV_ALERT_MAX_ATTEMPTS,
  cooldownMs: () => DEV_ALERT_DRAIN_COOLDOWN_MS,
};

export function devAlertDrainCooldownState() {
  return new Map(drainBlockedUntil);
}

export function clearDevAlertDrainCooldowns() {
  drainBlockedUntil.clear();
}

export interface DeveloperAlertDrainResult {
  retried: number;
  sent: number;
  abandoned: number;
  skipped: string | null;
}

export async function drainDeveloperAlertOutbox(instanceId: string): Promise<DeveloperAlertDrainResult> {
  if (!redisClient.isOpen) return { retried: 0, sent: 0, abandoned: 0, skipped: "redis_closed" };
  if (isDrainOnCooldown(instanceId)) return { retried: 0, sent: 0, abandoned: 0, skipped: "cooldown" };

  const indexKey = `dev_alert_outbox:${instanceId}`;
  const incidentIds: string[] = await redisClient
    .zRange(indexKey, 0, DEV_ALERT_RETRY_LIMIT - 1)
    .catch(() => [] as string[]);
  if (!incidentIds.length) {
    noteDrainHealthy(instanceId);
    return { retried: 0, sent: 0, abandoned: 0, skipped: null };
  }

  // Read the config once per pass. The old loop fetched it per incident even though
  // every incident of a tenant goes to the same developer phone.
  const config = await getRestaurantConfig(instanceId).catch(() => null);
  if (isDisabledTenant(config)) {
    // Nothing can be delivered to a tenant that is switched off. Its entries keep
    // their own TTL and expire on their own; retrying only produces 503 noise.
    noteDrainFailure(instanceId);
    return { retried: 0, sent: 0, abandoned: 0, skipped: "tenant_disabled" };
  }
  const developerPhone = normalizePhone(config?.dev_phone || process.env.OPENBOT_DEVELOPER_PHONE);
  if (!developerPhone) {
    noteDrainFailure(instanceId);
    return { retried: 0, sent: 0, abandoned: 0, skipped: "dev_phone_missing" };
  }

  let sent = 0;
  let abandoned = 0;
  for (const incidentId of incidentIds) {
    const entryKey = `${indexKey}:${incidentId}`;
    const raw = await redisClient.get(entryKey).catch(() => null);
    if (!raw) {
      // The entry expired; its index member is stale.
      await redisClient.zRem(indexKey, incidentId).catch(() => 0);
      continue;
    }
    let entry: Record<string, any> | null = null;
    try { entry = JSON.parse(raw); } catch { entry = null; }
    if (!entry?.text) {
      await redisClient.multi().del(entryKey).zRem(indexKey, incidentId).exec().catch(() => null);
      continue;
    }

    if (shouldAbandonAlert(entry.attempts)) {
      await redisClient.multi().del(entryKey).zRem(indexKey, incidentId).exec().catch(() => null);
      console.error(
        `[OPENBOT:DEV-ALERT:ABANDONED] instance=${instanceId} incident=${incidentId} attempts=${Number(entry.attempts || 0)}`
      );
      abandoned += 1;
      continue;
    }

    try {
      const result: any = await sendWhatsProMessage({ instanceId, phone: developerPhone, text: String(entry.text) });
      if (result?.acknowledged !== true) throw new Error(result?.reason || "DEVELOPER_ALERT_NOT_ACKNOWLEDGED");
      // Delivered: drop it from both the entry key and the index, so it is never re-sent.
      await redisClient.multi().del(entryKey).zRem(indexKey, incidentId).exec().catch(() => null);
      sent += 1;
    } catch {
      // Still failing. Keep the alert rather than losing it, but record the attempt and
      // preserve the remaining TTL - rewriting a full TTL on every retry would keep a
      // dead entry alive indefinitely.
      const ttl = await redisClient.ttl(entryKey).catch(() => -1);
      await redisClient
        .setEx(
          entryKey,
          ttl > 0 ? ttl : DEV_ALERT_OUTBOX_TTL_SECONDS,
          JSON.stringify({ ...entry, attempts: Number(entry.attempts || 0) + 1, lastAttemptAt: Date.now() })
        )
        .catch(() => null);
      // One failure means the transport is down for every entry of this tenant, so back
      // the tenant off instead of walking the rest of the budget on certain failures.
      noteDrainFailure(instanceId);
      return { retried: incidentIds.length, sent, abandoned, skipped: null };
    }
  }
  noteDrainHealthy(instanceId);
  return { retried: incidentIds.length, sent, abandoned, skipped: null };
}

async function sendAlertWithConfig(
  instanceId: string,
  config: Record<string, any>,
  error: unknown,
  meta: Record<string, unknown>
): Promise<boolean> {
  const developerPhone = normalizePhone(config.dev_phone || process.env.OPENBOT_DEVELOPER_PHONE);
  if (!developerPhone) {
    console.error(`[OPENBOT:DEV-ALERT:SKIP] instance=${instanceId} reason=dev_phone_missing`);
    return false;
  }
  if (isCustomerPhone(config, developerPhone, meta)) {
    console.error(`[OPENBOT:DEV-ALERT:SKIP] instance=${instanceId} reason=would_reach_guest_number`);
    return false;
  }

  const fingerprint = alertFingerprint(instanceId, error, meta);
  const dedupeSeconds = BOOT_ALERT_SCOPES.includes(String(meta.scope || "").trim())
    ? BOOT_ALERT_DEDUPE_SECONDS
    : ALERT_DEDUPE_SECONDS;
  if (!(await claimAlert(fingerprint, dedupeSeconds))) return false;

  const incidentId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${fingerprint.slice(0, 6)}`;
  const alertText = buildAlertText(instanceId, error, meta, incidentId);
  try {
    const result: any = await sendWhatsProMessage({ instanceId, phone: developerPhone, text: alertText });
    if (result?.acknowledged !== true) throw new Error(result?.reason || "DEVELOPER_ALERT_NOT_ACKNOWLEDGED");
    return true;
  } catch (sendError) {
    await persistDeveloperAlertOutbox(instanceId, incidentId, alertText, sendError);
    console.error(`[OPENBOT:DEV-ALERT:FAIL] instance=${instanceId} incident=${incidentId}:`, errorMessage(sendError));
    return false;
  }
}

export async function notifyDeveloperSystemFailure(
  instanceId: string,
  error: unknown,
  meta: Record<string, unknown> = {}
): Promise<boolean> {
  const safeInstanceId = String(instanceId || "").trim();
  if (!safeInstanceId) return false;
  try {
    const config = (await getRestaurantConfig(safeInstanceId).catch(() => null)) || {};
    return await sendAlertWithConfig(safeInstanceId, config, error, meta);
  } catch (notifyError) {
    console.error(`[OPENBOT:DEV-ALERT:CRASH] instance=${safeInstanceId}:`, errorMessage(notifyError));
    return false;
  }
}

export async function notifyAllDevelopersSystemFailure(
  error: unknown,
  meta: Record<string, unknown> = {}
): Promise<number> {
  try {
    const configs = await getAllRestaurantConfigs().catch(() => []);
    // One global failure used to be delivered once per tenant, so a single boot 401
    // arrived three times in a row on the same developer phone - and because that
    // phone is also a WhatsApp conversation, the spam looked like the bot writing to
    // a guest (audit, 2026-08-13). The alarm is now addressed per developer phone,
    // not per tenant, and a live tenant is preferred as the sender.
    const unique = new Map<string, Record<string, any>>();
    for (const config of configs) {
      const instanceId = String(config?.instance_id || config?.instance || "").trim();
      if (!instanceId) continue;
      const developerPhone = normalizePhone(config?.dev_phone || process.env.OPENBOT_DEVELOPER_PHONE);
      if (!developerPhone) continue;
      const current = unique.get(developerPhone);
      const currentEnabled = current ? !isDisabledTenant(current) : false;
      if (!current || (currentEnabled === false && !isDisabledTenant(config))) unique.set(developerPhone, config);
    }
    const results = await Promise.allSettled(
      [...unique.values()].map((config) =>
        sendAlertWithConfig(String(config?.instance_id || config?.instance || "").trim(), config, error, meta)
      )
    );
    return results.filter((result) => result.status === "fulfilled" && result.value).length;
  } catch (notifyError) {
    console.error("[OPENBOT:DEV-ALERT:GLOBAL:CRASH]", errorMessage(notifyError));
    return 0;
  }
}

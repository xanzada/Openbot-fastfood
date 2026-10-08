import crypto from "node:crypto";
import { createClient } from "redis";

const REDIS_CONNECT_TIMEOUT_MS = Math.max(
  500,
  Math.min(10_000, Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 2_500))
);

export const redisClient = createClient({
  url: process.env.REDIS_URL || "redis://localhost:6379",
  disableOfflineQueue: true,
  socket: {
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    reconnectStrategy: (retries) => Math.min(250 * (2 ** Math.min(retries, 5)), 5_000),
  },
});

let redisReady: Promise<void> | null = null;
let redisConnectLogged = false;

function redisUsable() {
  return redisClient.isReady ||
    (Boolean(process.env.NODE_TEST_CONTEXT) && redisClient.isOpen);
}

export function getRedisTarget() {
  const raw = process.env.REDIS_URL || "redis://localhost:6379";
  try {
    const url = new URL(raw);
    return {
      host: url.hostname || "unknown",
      port: url.port || "6379",
      database: url.pathname?.replace("/", "") || "0",
      configured: Boolean(process.env.REDIS_URL),
    };
  } catch {
    return {
      host: "invalid-url",
      port: "",
      database: "",
      configured: Boolean(process.env.REDIS_URL),
    };
  }
}

redisClient.on("error", (error: any) => {
  console.error("[REDIS] error:", error?.message || error);
});

export async function connectRedis(): Promise<void> {
  if (redisUsable()) return;
  if (!redisReady && !redisClient.isOpen) {
    const target = getRedisTarget();
    if (!redisConnectLogged) {
      console.log(`[OPENBOT:REDIS] connecting host=${target.host} port=${target.port} db=${target.database}`);
      redisConnectLogged = true;
    }
    redisReady = redisClient
      .connect()
      .then(() => {
        console.log(`[OPENBOT:REDIS] connected host=${target.host} port=${target.port}`);
      })
      .catch((error: any) => {
        console.error(`[OPENBOT:REDIS] connect failed host=${target.host} port=${target.port}:`, error?.message || error);
      })
      .finally(() => {
        redisReady = null;
      });
  }
  if (redisReady) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      redisReady,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, REDIS_CONNECT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
  if (!redisUsable()) throw new Error(`REDIS_NOT_READY:${REDIS_CONNECT_TIMEOUT_MS}ms`);
}

export async function pingRedis(): Promise<string> {
  await connectRedis();
  return redisClient.ping();
}

async function withRedisTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`REDIS_OPERATION_TIMEOUT:${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function safeRedis<T>(fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    const timeoutMs = Math.max(
      500,
      Math.min(10_000, Number(process.env.REDIS_OPERATION_TIMEOUT_MS || 2_500))
    );
    await withRedisTimeout(connectRedis(), timeoutMs);
    return await withRedisTimeout(fn(), timeoutMs);
  } catch {
    return fallback;
  }
}

function historyKey(instanceId: string, phone: string) {
  return `history:${instanceId}:${phone}`;
}

function whatsProHistoryKey(instanceId: string, phone: string) {
  return `chatwoot:history:${instanceId}:${phone}`;
}

function magicLinkKey(instanceId: string, phone: string) {
  return `has_sent_link:${instanceId}:${phone}`;
}

export const CHAT_HISTORY_TTL_SECONDS = 604800;
const CHAT_HISTORY_MAX_ITEMS = 120;
const MAGIC_LINK_SENT_TTL_SECONDS = 2592000;
export const USER_LANG_TTL_SECONDS = 24 * 60 * 60;
export const SITE_LANG_HINT_TTL_SECONDS = 24 * 60 * 60;
const RECEIPT_FINGERPRINT_TTL_SECONDS = 7 * 24 * 60 * 60;
const COMPLAINT_MEDIA_TTL_SECONDS = 300;
const DAILY_LOG_TTL_SECONDS = 172800;
const DAILY_LOG_MAX_ITEMS = Number(process.env.DAILY_LOG_MAX_ITEMS || 1000);
const KITCHEN_STATUS_TTL_SECONDS = 604800;

export interface PaymentDetail {
  label: string;
  value: string;
  source?: string;
}

export interface KitchenStatusState {
  wait_time: number;
  is_emergency: boolean;
  delivery: boolean;
  pickup: boolean;
  reset_at: number;
  // Whether the restaurant is open at all, and why not. These are hub facts, but
  // they have to survive in Redis: the fallback that reconstructs a runtime from
  // this record used to hard-code within_work_hours: true, so a guest who wrote at
  // 03:00 while the hub was unreachable was told the kitchen was open (audit,
  // 2026-08-12).
  is_accepting_orders: boolean;
  within_work_hours: boolean;
  closed_reason: string;
  payment_details: PaymentDetail[];
  source: string;
  synced_at: string;
}

function kitchenStatusKey(instanceId: string) {
  return `${instanceId}:kitchen_status`;
}

// Hub status events (status_changed / order_rejected) carry only the order id -
// never the guest's phone. The mapping is learned when an event that DOES carry
// the phone arrives (order.created, the operator confirm) and read back for the
// ones that do not, so the guest still gets "дайындалуда / курьерде / аяқталды".
const ORDER_PHONE_TTL_SECONDS = 7 * 24 * 60 * 60;

function orderPhoneKey(instanceId: string, orderId: string) {
  return `order_phone:${instanceId}:${orderId}`;
}

export async function saveOrderPhone(instanceId: string, orderId: string, phone: string): Promise<boolean> {
  const cleanOrderId = String(orderId || "").trim();
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!instanceId || !cleanOrderId || !cleanPhone) return false;
  return safeRedis(false, async () => {
    await connectRedis();
    await redisClient.setEx(orderPhoneKey(instanceId, cleanOrderId), ORDER_PHONE_TTL_SECONDS, cleanPhone);
    return true;
  });
}

export async function getOrderPhone(instanceId: string, orderId: string): Promise<string> {
  const cleanOrderId = String(orderId || "").trim();
  if (!instanceId || !cleanOrderId) return "";
  return safeRedis("", async () => {
    await connectRedis();
    const value = await redisClient.get(orderPhoneKey(instanceId, cleanOrderId));
    return typeof value === "string" ? value : "";
  });
}

// What the guest has already been told about this order. Status events are
// ranked so a stale replay (hub retries a rejected webhook for hours) can never
// move the guest backwards - e.g. a payment request landing after the order was
// cancelled, or "дайындалып жатыр" arriving after "курьерге берілді".
const ORDER_NOTIFY_CURSOR_TTL_SECONDS = 24 * 60 * 60;

function orderNotifyCursorKey(instanceId: string, orderId: string) {
  return `order_notify_cursor:${instanceId}:${orderId}`;
}

export async function getOrderNotifyCursor(instanceId: string, orderId: string): Promise<{ rank: number; status: string } | null> {
  const cleanOrderId = String(orderId || "").trim();
  if (!instanceId || !cleanOrderId) return null;
  return safeRedis(null, async () => {
    await connectRedis();
    const raw = await redisClient.get(orderNotifyCursorKey(instanceId, cleanOrderId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(String(raw));
      const rank = Number(parsed?.rank);
      return Number.isFinite(rank) ? { rank, status: String(parsed?.status || "") } : null;
    } catch {
      return null;
    }
  });
}

export async function saveOrderNotifyCursor(instanceId: string, orderId: string, rank: number, status: string): Promise<boolean> {
  const cleanOrderId = String(orderId || "").trim();
  if (!instanceId || !cleanOrderId || !Number.isFinite(rank)) return false;
  return safeRedis(false, async () => {
    await connectRedis();
    await redisClient.setEx(orderNotifyCursorKey(instanceId, cleanOrderId), ORDER_NOTIFY_CURSOR_TTL_SECONDS, JSON.stringify({ rank, status: String(status || "").slice(0, 60) }));
    return true;
  });
}

// The last order id the guest touched, from the getOrderStatus cache. Receipt
// test mode uses it to attach a receipt even when the hub no longer lists the
// order as active (e.g. a cancelled test order).
export async function getLastKnownOrderId(instanceId: string, phone: string): Promise<string> {
  const cleanPhone = String(phone || "").replace(/\D/g, "");
  if (!instanceId || !cleanPhone) return "";
  return safeRedis("", async () => {
    await connectRedis();
    const raw = await redisClient.get(`last_order:${instanceId}:${cleanPhone}`);
    if (!raw) return "";
    try {
      const parsed = JSON.parse(String(raw));
      const id = parsed?.order_id || parsed?.active_order?.id || parsed?.order?.id || "";
      return String(id || "").trim();
    } catch {
      return "";
    }
  });
}

// Hub status/reject events carry only the order id. For orders that predate
// the order_phone map, walk the phone-keyed last_order cache and return the
// phone whose cached order matches. Small tenant base - a bounded SCAN is fine.
export async function getPhoneByOrderScan(instanceId: string, orderId: string): Promise<string> {
  const cleanOrderId = String(orderId || "").trim();
  if (!instanceId || !cleanOrderId) return "";
  return safeRedis("", async () => {
    await connectRedis();
    const prefix = `last_order:${instanceId}:`;
    let cursor = 0;
    for (let batch = 0; batch < 20; batch += 1) {
      const res: any = await (redisClient as any).scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
      const keys: string[] = Array.isArray(res?.keys) ? res.keys : [];
      for (const key of keys) {
        const raw = await redisClient.get(key);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(String(raw));
          const id = String(parsed?.order_id || parsed?.active_order?.id || parsed?.order?.id || "").trim();
          if (id && id === cleanOrderId) return key.slice(prefix.length);
        } catch {
          // not JSON - skip
        }
      }
      const nextCursor = Number(res?.cursor ?? 0);
      if (!nextCursor) break;
      cursor = nextCursor;
    }
    return "";
  });
}

const KITCHEN_CONSENT_TTL_SECONDS = 30 * 60;
const KITCHEN_CHECKOUT_GRACE_TTL_SECONDS = 30 * 60;

function kitchenConsentKey(instanceId: string, phone: string) {
  return `kitchen_consent:${instanceId}:${phone}`;
}

function kitchenCheckoutGraceKey(instanceId: string, phone: string) {
  return `kitchen_checkout_grace:${instanceId}:${phone}`;
}

export type PendingKitchenConsentKind = "delay" | "channel" | "delay_and_channel";
export type PendingKitchenChannel = "delivery" | "pickup" | "unknown";
export interface PendingKitchenConsent {
  policyFingerprint: string;
  kind: PendingKitchenConsentKind;
  channel: PendingKitchenChannel;
  deferredMenuLinkIntent: boolean;
}

export async function savePendingKitchenConsent(
  instanceId: string,
  phone: string,
  policyFingerprint: string,
  kind: PendingKitchenConsentKind = "delay",
  deferredMenuLinkIntent = false,
  channel: PendingKitchenChannel = "unknown",
): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(
      kitchenConsentKey(instanceId, phone),
      JSON.stringify({ policyFingerprint, kind, channel, deferredMenuLinkIntent: Boolean(deferredMenuLinkIntent), createdAt: Date.now() }),
      { EX: KITCHEN_CONSENT_TTL_SECONDS }
    );
    return result === "OK";
  });
}

export async function getPendingKitchenConsent(instanceId: string, phone: string): Promise<PendingKitchenConsent | null> {
  return safeRedis(null, async () => {
    const raw = await redisClient.get(kitchenConsentKey(instanceId, phone));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      const kind: PendingKitchenConsentKind = ["delay", "channel", "delay_and_channel"].includes(parsed?.kind) ? parsed.kind : "delay";
      const channel: PendingKitchenChannel = ["delivery", "pickup", "unknown"].includes(parsed?.channel) ? parsed.channel : "unknown";
      return parsed?.policyFingerprint
        ? { policyFingerprint: String(parsed.policyFingerprint), kind, channel, deferredMenuLinkIntent: parsed.deferredMenuLinkIntent === true }
        : null;
    } catch {
      return null;
    }
  });
}

export async function clearPendingKitchenConsent(instanceId: string, phone: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(kitchenConsentKey(instanceId, phone));
  });
}

// The grace stores the kitchen policy as it stood when the link went out, so a
// guest mid-order is not interrupted for conditions that never changed, while a
// genuine change still reaches them on their next message.
export async function markKitchenCheckoutStarted(instanceId: string, phone: string, policyFingerprint = ""): Promise<boolean> {
  return safeRedis(false, async () => {
    const value = policyFingerprint || String(Date.now());
    const result = await redisClient.set(kitchenCheckoutGraceKey(instanceId, phone), value, { EX: KITCHEN_CHECKOUT_GRACE_TTL_SECONDS });
    return result === "OK";
  });
}

export async function hasActiveKitchenCheckout(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => Boolean(await redisClient.get(kitchenCheckoutGraceKey(instanceId, phone))));
}

// The grace window is a sliding one. A fixed 30 minutes meant a guest still
// choosing dishes was asked to accept the same wait a second time, which reads
// like the bot forgot the conversation (audit, 2026-08-12). Every turn that finds
// the same kitchen state renews it, so only silence lets it lapse.
export async function getKitchenCheckoutFingerprint(instanceId: string, phone: string): Promise<string | null> {
  return safeRedis(null, async () => {
    const value = await redisClient.get(kitchenCheckoutGraceKey(instanceId, phone));
    if (!value) return null;
    await redisClient.expire(kitchenCheckoutGraceKey(instanceId, phone), KITCHEN_CHECKOUT_GRACE_TTL_SECONDS).catch(() => undefined);
    return String(value);
  });
}

export async function clearKitchenCheckoutState(instanceId: string, phone: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del([kitchenCheckoutGraceKey(instanceId, phone), kitchenConsentKey(instanceId, phone)]);
  });
}

function toBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizePaymentDetails(value: unknown): PaymentDetail[] {
  return parseJsonArray(value)
    .map((item) => {
      const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      return {
        label: String(source.label || source.name || source.title || "Реквизит").trim().slice(0, 60),
        value: String(source.value || source.number || source.url || source.link || "").trim().slice(0, 250),
        source: source.source ? String(source.source).trim().slice(0, 40) : undefined,
      };
    })
    .filter((item) => item.value)
    .slice(0, 6);
}

// The real number the kitchen entered, clamped only to a sane range. It used to
// be floored to 0 below 41 minutes because the sales policy calls anything up to
// 40 "normal" - but the policy already applies that threshold itself, and
// throwing the value away meant a guest asking "how long?" while the kitchen had
// entered 35 was told nothing at all, and the panel looked like it had dropped
// the write (audit, 2026-08-12). Storing the truth lets the mode stay normal AND
// the estimate be quoted.
function normalizeKitchenWaitTime(value: unknown): number {
  return Math.min(720, Math.max(0, Math.floor(Number(value ?? 0) || 0)));
}

function normalizeKitchenStatus(
  value: Record<string, any> = {},
  previous?: KitchenStatusState | PaymentDetail[] | null
): KitchenStatusState {
  const previousState = Array.isArray(previous) ? null : previous || null;
  const previousPaymentDetails = Array.isArray(previous) ? previous : previousState?.payment_details || [];
  const paymentDetails = normalizePaymentDetails(value.payment_details).length
    ? normalizePaymentDetails(value.payment_details)
    : previousPaymentDetails;
  const hoursValid = Math.min(120, Math.max(0, Number(value.hours_valid || value.hoursValid || 0) || 0));
  const preserveReset = toBool(value.preserve_reset ?? value.preserveReset, false);
  const now = Math.floor(Date.now() / 1000);
  const resetAt =
    preserveReset
      ? Math.min(now + 5 * 86400, Math.max(0, Number(value.reset_at || value.resetAt || 0) || 0))
      : hoursValid > 0
        ? Math.floor(now + hoursValid * 3600)
        : Math.max(0, Number(value.reset_at || value.resetAt || 0) || 0);
  // A panel push carries a wait time and a pause, never the opening hours. It must
  // not silently reopen a closed restaurant, so openness falls back to whatever
  // was already stored before it defaults to open.
  const withinWorkHours = toBool(
    value.within_work_hours ?? value.withinWorkHours,
    previousState ? previousState.within_work_hours : true,
  );
  const isEmergency = toBool(value.is_emergency ?? value.isEmergency, false);
  const delivery = toBool(value.delivery, true);
  const pickup = toBool(value.pickup, true);

  return {
    wait_time: normalizeKitchenWaitTime(value.wait_time ?? value.waitTime),
    is_emergency: isEmergency,
    delivery,
    pickup,
    reset_at: resetAt,
    is_accepting_orders:
      toBool(
        value.is_accepting_orders ?? value.isAcceptingOrders,
        previousState ? previousState.is_accepting_orders : true,
      ) && withinWorkHours && !isEmergency && (delivery || pickup),
    within_work_hours: withinWorkHours,
    closed_reason: String(value.closed_reason ?? value.closedReason ?? previousState?.closed_reason ?? "").trim().slice(0, 120),
    payment_details: paymentDetails,
    source: String(value.source || "redis_kitchen_status").trim(),
    synced_at: new Date().toISOString(),
  };
}

function parseHistoryRows(rows: string[], store: "openbot" | "whatspro") {
  return rows.map((item: any, index) => {
    try {
      const entry = JSON.parse(item);
      return { ...entry, __historyStore: store, __historyIndex: index };
    } catch {
      return null;
    }
  }).filter((entry: any) => Boolean(entry) && entry.source !== "openbot_operator_case");
}

function historyRole(entry: any) {
  const role = String(entry?.role || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  if (role === "operator" || source === "operator_panel" || source === "whatsapp_app") return "operator";
  if (["assistant", "model", "bot", "ai"].includes(role) || entry?.direction === "outgoing" || entry?.fromMe === true) return "assistant";
  if (role === "system") return "system";
  return "user";
}

function mergeConversationHistory(openbotRows: string[], whatsProRows: string[]) {
  const combined = [
    ...parseHistoryRows(openbotRows, "openbot"),
    ...parseHistoryRows(whatsProRows, "whatspro"),
  ].sort((a: any, b: any) =>
    (Number(a?.createdAt || a?.timestamp || 0) - Number(b?.createdAt || b?.timestamp || 0)) ||
    (Number(a?.__historyIndex || 0) - Number(b?.__historyIndex || 0))
  );

  const result: any[] = [];
  const ids = new Set<string>();
  for (const entry of combined) {
    const id = String(entry?.id || entry?.messageId || "").trim();
    if (id && ids.has(id)) continue;

    const role = historyRole(entry);
    const text = String(entry?.text || entry?.body || "").replace(/\s+/g, " ").trim();
    const createdAt = Number(entry?.createdAt || entry?.timestamp || 0) || 0;
    const duplicateIndex = result.findIndex((current) => {
      if (historyRole(current) !== role) return false;
      const currentText = String(current?.text || current?.body || "").replace(/\s+/g, " ").trim();
      const currentAt = Number(current?.createdAt || current?.timestamp || 0) || 0;
      return Boolean(text && text === currentText && createdAt && currentAt && Math.abs(createdAt - currentAt) <= 15000);
    });
    if (duplicateIndex >= 0) {
      if (role === "operator" && historyRole(result[duplicateIndex]) !== "operator") result[duplicateIndex] = entry;
      if (id) ids.add(id);
      continue;
    }
    if (id) ids.add(id);
    result.push(entry);
  }

  return result.map(({ __historyStore, __historyIndex, ...entry }) => entry);
}

export async function getChatHistory(instanceId: string, phone: string): Promise<any[]> {
  return safeRedis([], async () => {
    const [openbotRows, whatsProRows] = await Promise.all([
      redisClient.lRange(historyKey(instanceId, phone), 0, -1),
      redisClient.lRange(whatsProHistoryKey(instanceId, phone), 0, -1),
    ]);
    return mergeConversationHistory(openbotRows, whatsProRows);
  });
}

export async function saveToHistory(
  instanceId: string,
  phone: string,
  role: "user" | "assistant" | "system" | "operator" | "model",
  text: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  if (!text) return;
  await safeRedis(undefined, async () => {
    const key = historyKey(instanceId, phone);
    const ttlBefore = await redisClient.ttl(key);
    const entry = JSON.stringify({ role, text, createdAt: Date.now(), ...meta });
    await redisClient.multi().rPush(key, entry).lTrim(key, -CHAT_HISTORY_MAX_ITEMS, -1).exec();
    // Re-assert the 7-day window whenever the key carries LESS than that, not only
    // when it carries no TTL at all.
    //
    // WHY: this key is shared. WhatsPro treats `history:{instance}:{phone}` as its
    // own "legacyHistory" and re-stamps it with the panel's 24h chat TTL on every
    // stored message (chatStore.js applyTtl / setState / pruneExpired). Openbot
    // keeps it for 7 days because that is the window support reads a complaint back
    // over. With `ttlBefore < 0` as the only condition, WhatsPro always won and
    // Openbot's 7 days never actually held - verified live on 2026-08-22, where
    // every history key still showed ~24h after the operatorCase fix.
    //
    // Openbot writes to this key on every turn, so re-asserting here converges on
    // 7 days without touching WhatsPro's chat-storage Lua, which the inbound WAL
    // depends on. A LONGER ttl is left alone: whoever set it wanted it.
    if (ttlBefore < 0 || ttlBefore < CHAT_HISTORY_TTL_SECONDS) {
      await redisClient.expire(key, CHAT_HISTORY_TTL_SECONDS);
    }
  });
}

// Pending notification records deliberately have no TTL. Expiry is not proof
// that WhatsPro did not accept a request, and its accepted WAL lasts only 24 h.
const SITE_NOTIFICATION_SCHEMA = "SITE_NOTIFICATION_JOURNAL_V1";
const SITE_NOTIFICATION_EVENT_SCHEMA = "SITE_NOTIFICATION_EVENT_V1";
export const SITE_NOTIFICATION_REPLAY_WINDOW_MS = 24 * 60 * 60_000 - 60_000;
const SITE_NOTIFICATION_LEASE_MS = 20_000;

export interface SiteNotificationPayload {
  instance: string;
  orderId: string;
  phone: string;
  text: string;
  requestId: string;
  rank: number;
  status: string;
  clearOrderPointer: boolean;
  createdAt: number;
}

export interface SiteNotificationClaim {
  key: string;
  leaseKey: string;
  token: string;
  state: {
    schema: typeof SITE_NOTIFICATION_SCHEMA;
    instance: string;
    orderId: string;
    phase: "pending" | "acknowledged" | "complete" | "no_send";
    eventKeys: Record<string, true>;
    payload?: SiteNotificationPayload;
    attemptedAt?: number;
    acknowledgedAt?: number;
    messageId?: string;
    reason?: string;
  };
}

const siteNotificationClaimLua = `-- SITE_NOTIFICATION_CLAIM_V1
local function stringKey(k)
  local t=redis.call('TYPE',k).ok
  return t=='none' or t=='string'
end
local function reconcile(reason,source,value)
  local marker=cjson.encode({schema='SITE_NOTIFICATION_RECONCILIATION_V1',sourceKey=source,sourceSHA1=type(value)=='string' and redis.sha1hex(value) or '',reason=reason,observedAt=tonumber(ARGV[7])})
  -- Separate persistent markers do not erase, relabel, renew or shorten the
  -- original legacy/unknown key. Its TTL expiry never proves a fresh send.
  redis.call('SET',KEYS[4],marker,'NX')
  if ARGV[4]~='' then redis.call('SET',KEYS[5],marker,'NX') end
  return {'reconcile',''}
end
if redis.call('EXISTS',KEYS[4])==1 or (ARGV[4]~='' and redis.call('EXISTS',KEYS[5])==1) then return {'reconcile',''} end
if not stringKey(KEYS[1]) or not stringKey(KEYS[2]) or not stringKey(KEYS[3]) then return reconcile('unproven_type',KEYS[1],'') end
local raw=redis.call('GET',KEYS[1])
local alias=ARGV[4]~='' and redis.call('GET',KEYS[3]) or false
if alias then
  local ok,a=pcall(cjson.decode,alias)
  if not ok or type(a)~='table' or a.schema~=ARGV[6] or type(a.journalKey)~='string' then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
  if a.journalKey~=KEYS[1] then
    if string.sub(a.journalKey,1,#KEYS[1]+9)~=KEYS[1]..':no_send:' then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
    if not stringKey(a.journalKey) then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
    local decision=redis.call('GET',a.journalKey);if not decision then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
    local valid,d=pcall(cjson.decode,decision);local expected=cjson.decode(ARGV[3])
    if not valid or type(d)~='table' or d.schema~=ARGV[5] or d.phase~='no_send' or d.instance~=expected.instance or d.orderId~=expected.orderId or d.payload or type(d.reason)~='string' or d.reason=='' then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
    return {'complete',decision}
  end
  if not raw then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
end
local s
if raw then
  local ok,decoded=pcall(cjson.decode,raw)
  if not ok or type(decoded)~='table' or decoded.schema~=ARGV[5] then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
  s=decoded
  local expected=cjson.decode(ARGV[3])
  if s.instance~=expected.instance or s.orderId~=expected.orderId or type(s.eventKeys)~='table' then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
  if s.phase~='pending' and s.phase~='acknowledged' and s.phase~='complete' and s.phase~='no_send' then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
else s=cjson.decode(ARGV[3]) end
if s.phase=='complete' and (not s.payload or not s.attemptedAt or not s.acknowledgedAt) then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
if s.phase=='no_send' and (s.payload or type(s.reason)~='string' or s.reason=='') then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
if s.phase=='complete' or s.phase=='no_send' then
  if ARGV[4]~='' and not alias then redis.call('SET',KEYS[3],cjson.encode({schema=ARGV[6],journalKey=KEYS[1]})) end
  return {'complete',cjson.encode(s)}
end
if redis.call('EXISTS',KEYS[2])==1 then return {'busy',''} end
if ARGV[4]~='' and not alias then
  local count=0;for _ in pairs(s.eventKeys) do count=count+1 end
  if count>=64 then return reconcile('unproven_scope',alias and KEYS[3] or KEYS[1],alias or raw) end
  s.eventKeys[KEYS[3]]=true
end
redis.call('SET',KEYS[2],ARGV[1],'PX',ARGV[2])
redis.call('SET',KEYS[1],cjson.encode(s))
if ARGV[4]~='' then redis.call('SET',KEYS[3],cjson.encode({schema=ARGV[6],journalKey=KEYS[1]})) end
return {'acquired',cjson.encode(s)}
`;

const siteNotificationUpdateLua = `-- SITE_NOTIFICATION_UPDATE_V1
if redis.call('GET',KEYS[2])~=ARGV[1] then return {'lease_lost',''} end
local raw=redis.call('GET',KEYS[1])
if not raw then return {'reconcile',''} end
local ok,s=pcall(cjson.decode,raw)
if not ok or type(s)~='table' or s.schema~=ARGV[5] then return {'reconcile',''} end
local op=ARGV[2]
if op=='renew' then redis.call('PEXPIRE',KEYS[2],ARGV[3]); return {'ok',raw} end
if op=='release' then redis.call('DEL',KEYS[2]); return {'ok',raw} end
if op=='prepare' then
  if s.phase~='pending' then return {'reconcile',''} end
  if not s.payload then s.payload=cjson.decode(ARGV[4]) end
elseif op=='attempt' then
  if s.phase~='pending' or not s.payload then return {'reconcile',''} end
  if s.attemptedAt and (type(s.attemptedAt)~='number' or tonumber(ARGV[3])<s.attemptedAt or tonumber(ARGV[3])-s.attemptedAt>=tonumber(ARGV[4])) then return {'reconcile',''} end
  if not s.attemptedAt then s.attemptedAt=tonumber(ARGV[3]) end
elseif op=='ack' then
  if s.phase~='pending' or not s.payload or not s.attemptedAt then return {'reconcile',''} end
  s.phase='acknowledged';s.acknowledgedAt=tonumber(ARGV[3]);s.messageId=ARGV[4]
elseif op=='reset_cursor' then
  local kind=redis.call('TYPE',KEYS[3]).ok
  if kind~='none' and kind~='string' then return {'reconcile',''} end
  local previous=redis.call('GET',KEYS[3])
  if previous then
    local parsed,c=pcall(cjson.decode,previous)
    if not parsed or type(c)~='table' or type(c.rank)~='number' then return {'reconcile',''} end
    if c.rank<tonumber(ARGV[4]) then redis.call('SET',KEYS[3],cjson.encode({rank=0,status='payment_timing_changed'}),'EX',ARGV[3]) end
  end
  return {'ok',raw}
else return {'reconcile',''} end
redis.call('SET',KEYS[1],cjson.encode(s))
return {'ok',cjson.encode(s)}
`;

const siteNotificationFinishLua = `-- SITE_NOTIFICATION_FINISH_V1
if redis.call('GET',KEYS[2])~=ARGV[1] then return 0 end
local raw=redis.call('GET',KEYS[1]);if not raw then return 0 end
local ok,s=pcall(cjson.decode,raw)
if not ok or type(s)~='table' or s.schema~=ARGV[2] or type(s.eventKeys)~='table' then return 0 end
for k,v in pairs(s.eventKeys) do
  local t=redis.call('TYPE',k).ok;if t~='string' then return 0 end
  local valid,a=pcall(cjson.decode,redis.call('GET',k))
  if v~=true or not valid or type(a)~='table' or a.schema~=ARGV[3] or a.journalKey~=KEYS[1] then return 0 end
end
if ARGV[4]=='no_send' then
  if s.phase~='pending' or s.payload or ARGV[5]=='' then return 0 end
  s.phase='no_send';s.reason=ARGV[5]
else
  if s.phase~='acknowledged' or not s.payload or not s.acknowledgedAt then return 0 end
  local ht=redis.call('TYPE',KEYS[3]).ok
  local ct=redis.call('TYPE',KEYS[4]).ok
  if (ht~='none' and ht~='list') or (ct~='none' and ct~='string') then return 0 end
  local previous=redis.call('GET',KEYS[4]);local rank=-1
  if previous then
    local parsed,c=pcall(cjson.decode,previous)
    if not parsed or type(c)~='table' or type(c.rank)~='number' then return 0 end
    rank=c.rank
  end
  local entry=cjson.encode({role='model',text='<bot_notification>\\n'..s.payload.text..'\\n</bot_notification>',createdAt=s.payload.createdAt})
  local ttl=redis.call('TTL',KEYS[3])
  redis.call('RPUSH',KEYS[3],entry);redis.call('LTRIM',KEYS[3],-tonumber(ARGV[6]),-1)
  if ttl<tonumber(ARGV[7]) then redis.call('EXPIRE',KEYS[3],ARGV[7]) end
  if s.payload.rank>=0 and s.payload.rank>rank then
    redis.call('SET',KEYS[4],cjson.encode({rank=s.payload.rank,status=s.payload.status}),'EX',ARGV[8])
  end
  if s.payload.clearOrderPointer then
    local cacheType=redis.pcall('TYPE',KEYS[5])
    local cacheRaw=cacheType.ok=='string' and redis.pcall('GET',KEYS[5]) or false
    local decoded,c=false,nil
    if type(cacheRaw)=='string' then decoded,c=pcall(cjson.decode,cacheRaw) end
    if decoded and type(c)=='table' then
      local matching=false;local proven=true
      local function checkId(id)
        if type(id)=='string' then id=id:match('^%s*(.-)%s*$')
        elseif type(id)=='number' and id>0 and id<=9007199254740991 and id==math.floor(id) then id=tostring(id)
        else proven=false;return end
        if id=='' or id~=s.orderId then proven=false else matching=true end
      end
      if c.order_id~=nil then checkId(c.order_id) end
      for _,field in ipairs({'active_order','order'}) do
        if c[field]~=nil then
          if type(c[field])~='table' or c[field].id==nil then proven=false
          else checkId(c[field].id) end
        end
      end
      if matching and proven then redis.call('DEL',KEYS[5]) end
    end
  end
  s.phase='complete'
end
local destination=KEYS[1]
if ARGV[4]=='no_send' and ARGV[9]=='1' then destination=KEYS[1]..':no_send:'..ARGV[1] end
redis.call('SET',destination,cjson.encode(s))
for k in pairs(s.eventKeys) do
  redis.call('SET',k,cjson.encode({schema=ARGV[3],journalKey=destination}))
end
if destination~=KEYS[1] then redis.call('DEL',KEYS[1]) end
redis.call('DEL',KEYS[2]);return 1
`;

function validSiteNotificationPayload(payload: SiteNotificationPayload, instance: string, orderId: string) {
  return payload && typeof payload === "object" && payload.instance === instance && payload.orderId === orderId
    && typeof payload.phone === "string" && /^\d{7,15}$/.test(payload.phone)
    && typeof payload.text === "string" && payload.text.length > 0 && Buffer.byteLength(payload.text) <= 64 * 1024
    && typeof payload.requestId === "string" && /^[a-f0-9]{64}$/.test(payload.requestId)
    && Number.isInteger(payload.rank) && payload.rank >= -1 && typeof payload.status === "string" && payload.status.length <= 60
    && typeof payload.clearOrderPointer === "boolean" && Number.isSafeInteger(payload.createdAt) && payload.createdAt > 0;
}

export async function fenceLegacyMinuteNotification(instance: string, orderId: string, scope: "receipt_resend" | "timing_change") {
  await connectRedis();
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(instance) || !/^[a-zA-Z0-9-]{1,40}$/.test(orderId)) throw new Error("NOTIFICATION_SCOPE_INVALID");
  const suffix = scope === "receipt_resend" ? "request_payment:receipt_resend:t"
    : scope === "timing_change" ? "payment_timing_changed:revt" : "";
  if (!suffix) throw new Error("NOTIFICATION_SCOPE_INVALID");
  const prefix = `kanban_lock:${instance}:${orderId}:${suffix}`;
  const markerKey = `${prefix}:reconcile`;
  if (await redisClient.exists(markerKey)) return false;
  // Only the two changed legacy minute namespaces are queried. No raw record
  // or TTL is altered. An incomplete/failed lookup is never absence evidence.
  let cursor = "0", reason = "", sourceKey = "";
  const startedAt = Date.now();
  try {
    for (let page = 0; page < 128; page += 1) {
      const reply: unknown = await redisClient.sendCommand(["SCAN", cursor, "MATCH", `${prefix}*`, "COUNT", "256"]);
      if (!Array.isArray(reply) || reply.length !== 2 || typeof reply[0] !== "string" || !/^\d+$/.test(reply[0])
        || !Array.isArray(reply[1]) || reply[1].length > 64
        || reply[1].some((key: unknown) => typeof key !== "string" || !key.startsWith(prefix))) {
        reason = "legacy_lookup_unproven"; break;
      }
      if (reply[1].length) {
        sourceKey = reply[1][0];
        reason = /^\d+$/.test(sourceKey.slice(prefix.length)) ? "legacy_record_present" : "legacy_namespace_unproven";
        break;
      }
      if (Date.now() < startedAt || Date.now() - startedAt >= 2_000) { reason = "legacy_lookup_deadline"; break; }
      cursor = reply[0];
      if (cursor === "0") return true;
    }
    if (!reason) reason = "legacy_lookup_bounded_out";
  } catch { reason = "legacy_lookup_unproven"; }
  // Persistent separate uncertainty survives the old 24h literal1 TTL. No
  // automatic clear/migration/resend exists. A failed marker write throws.
  await redisClient.set(markerKey, JSON.stringify({ schema: "SITE_NOTIFICATION_RECONCILIATION_V1", reason, sourceKey, observedAt: Date.now() }), { NX: true });
  return false;
}

export async function claimSiteNotification(instance: string, orderId: string, key: string, eventKey: string) {
  await connectRedis();
  if (!key.startsWith(`kanban_lock:${instance}:${orderId}:`) || (eventKey && !eventKey.startsWith(`kanban_event_lock:${instance}:`))) throw new Error("NOTIFICATION_SCOPE_INVALID");
  const token = crypto.randomUUID();
  const leaseKey = `${key}:processing`;
  const initial = { schema: SITE_NOTIFICATION_SCHEMA, instance, orderId, phase: "pending", eventKeys: {} };
  const result = await redisClient.eval(siteNotificationClaimLua, { keys: [key, leaseKey, eventKey || `${key}:no_event`, `${key}:reconcile`, eventKey ? `${eventKey}:reconcile` : `${key}:no_event:reconcile`], arguments: [token, String(SITE_NOTIFICATION_LEASE_MS), JSON.stringify(initial), eventKey, SITE_NOTIFICATION_SCHEMA, SITE_NOTIFICATION_EVENT_SCHEMA, String(Date.now())] }) as string[];
  if (result?.[0] !== "acquired" && result?.[0] !== "complete") return { status: result?.[0] === "busy" ? "busy" as const : "reconcile" as const };
  const state = JSON.parse(result[1]) as SiteNotificationClaim["state"];
  if (state.instance !== instance || state.orderId !== orderId || !state.eventKeys || typeof state.eventKeys !== "object" || Array.isArray(state.eventKeys) || Object.keys(state.eventKeys).length > 64 || Object.entries(state.eventKeys).some(([k, v]) => v !== true || !k.startsWith(`kanban_event_lock:${instance}:`)) || (state.payload && !validSiteNotificationPayload(state.payload, instance, orderId)) || (state.attemptedAt !== undefined && (!state.payload || !Number.isSafeInteger(state.attemptedAt) || state.attemptedAt <= 0)) || ((state.phase === "acknowledged" || state.phase === "complete") && (!state.payload || !state.attemptedAt || !Number.isSafeInteger(state.acknowledgedAt) || Number(state.acknowledgedAt) <= 0))) {
    const marker = JSON.stringify({ schema: "SITE_NOTIFICATION_RECONCILIATION_V1", sourceKey: key, returnedStateSHA256: crypto.createHash("sha256").update(result[1]).digest("hex"), reason: "malformed_returned_state", observedAt: Date.now() });
    await redisClient.set(`${key}:reconcile`, marker, { NX: true });
    if (eventKey) await redisClient.set(`${eventKey}:reconcile`, marker, { NX: true });
    await redisClient.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", { keys: [leaseKey], arguments: [token] });
    return { status: "reconcile" as const };
  }
  if (result[0] === "complete") return { status: "complete" as const };
  return { status: "acquired" as const, claim: { key, leaseKey, token, state } };
}

async function updateSiteNotification(claim: SiteNotificationClaim, op: string, value: string, data = "", cursorKey = `${claim.key}:unused`) {
  await connectRedis();
  const result = await redisClient.eval(siteNotificationUpdateLua, { keys: [claim.key, claim.leaseKey, cursorKey], arguments: [claim.token, op, value, data, SITE_NOTIFICATION_SCHEMA] }) as string[];
  if (result?.[0] !== "ok") throw new Error(result?.[0] === "lease_lost" ? "NOTIFICATION_LEASE_LOST" : "NOTIFICATION_RECONCILIATION_REQUIRED");
  claim.state = JSON.parse(result[1]) as SiteNotificationClaim["state"];
}

export async function renewSiteNotification(claim: SiteNotificationClaim) {
  await updateSiteNotification(claim, "renew", String(SITE_NOTIFICATION_LEASE_MS));
}

export async function releaseSiteNotification(claim: SiteNotificationClaim) {
  // A completed claim already removed its lease; a stale owner must not delete
  // the replacement token. Release is cleanup, never delivery evidence.
  await redisClient.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0", { keys: [claim.leaseKey], arguments: [claim.token] });
}

export async function prepareSiteNotification(claim: SiteNotificationClaim, payload: SiteNotificationPayload) {
  if (!validSiteNotificationPayload(payload, claim.state.instance, claim.state.orderId)) throw new Error("NOTIFICATION_PAYLOAD_INVALID");
  await updateSiteNotification(claim, "prepare", "", JSON.stringify(payload));
}

export async function attemptSiteNotification(claim: SiteNotificationClaim) {
  await updateSiteNotification(claim, "attempt", String(Date.now()), String(SITE_NOTIFICATION_REPLAY_WINDOW_MS));
}

export async function acknowledgeSiteNotification(claim: SiteNotificationClaim, messageId: unknown) {
  await updateSiteNotification(claim, "ack", String(Date.now()), String(messageId ?? "").slice(0, 120));
}

export async function resetSiteNotificationCursor(claim: SiteNotificationClaim, maximumRank: number) {
  await updateSiteNotification(claim, "reset_cursor", String(ORDER_NOTIFY_CURSOR_TTL_SECONDS), String(maximumRank), orderNotifyCursorKey(claim.state.instance, claim.state.orderId));
}

export async function finishSiteNotification(claim: SiteNotificationClaim, noSendReason = "", releaseScope = false) {
  await connectRedis();
  const s = claim.state;
  const result = await redisClient.eval(siteNotificationFinishLua, { keys: [claim.key, claim.leaseKey, historyKey(s.instance, s.payload?.phone || "no_send"), orderNotifyCursorKey(s.instance, s.orderId), `last_order:${s.instance}:${s.payload?.phone || "no_send"}`], arguments: [claim.token, SITE_NOTIFICATION_SCHEMA, SITE_NOTIFICATION_EVENT_SCHEMA, noSendReason ? "no_send" : "delivered", noSendReason, String(CHAT_HISTORY_MAX_ITEMS), String(CHAT_HISTORY_TTL_SECONDS), String(ORDER_NOTIFY_CURSOR_TTL_SECONDS), releaseScope ? "1" : "0"] });
  if (result !== 1) throw new Error("NOTIFICATION_EFFECTS_NOT_COMMITTED");
}

export function languageKey(instanceId: string, phone: string) {
  return `lang:${instanceId}:${phone}`;
}

export function siteLanguageHintKey(instanceId: string, phone: string) {
  return `site_lang_hint:${instanceId}:${phone}`;
}

export function receiptFingerprintKey(instanceId: string, fingerprint: string) {
  return `receipt_seen:${instanceId}:${fingerprint}`;
}

export function languageSetOptions() {
  return { EX: USER_LANG_TTL_SECONDS, NX: true as const };
}

export async function getUserLang(instanceId: string, phone: string): Promise<"kk" | "ru" | null> {
  return safeRedis(null, async () => {
    const value = await redisClient.get(languageKey(instanceId, phone));
    return value === "kk" || value === "ru" ? value : null;
  });
}

export async function saveUserLang(instanceId: string, phone: string, lang: "kk" | "ru"): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(languageKey(instanceId, phone), lang, languageSetOptions());
    return result === "OK";
  });
}

export async function replaceUserLang(instanceId: string, phone: string, lang: "kk" | "ru"): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(languageKey(instanceId, phone), lang, { EX: USER_LANG_TTL_SECONDS });
    return result === "OK";
  });
}

// Support needs to see why a guest is being answered in one language and to undo
// a wrong lock without waiting out its 24 hours.
export async function getUserLangState(instanceId: string, phone: string) {
  return safeRedis({ language: null as "kk" | "ru" | null, ttlSeconds: -2, siteHint: null as "kk" | "ru" | null }, async () => {
    const key = languageKey(instanceId, phone);
    const [value, ttl, hint] = await Promise.all([
      redisClient.get(key),
      redisClient.ttl(key),
      redisClient.get(siteLanguageHintKey(instanceId, phone)),
    ]);
    return {
      language: value === "kk" || value === "ru" ? value : null,
      ttlSeconds: Number(ttl),
      siteHint: hint === "kk" || hint === "ru" ? hint : null,
    };
  });
}

export async function clearUserLang(instanceId: string, phone: string): Promise<number> {
  return safeRedis(0, async () => {
    const removed = await redisClient.del([languageKey(instanceId, phone), siteLanguageHintKey(instanceId, phone)]);
    return Number(removed) || 0;
  });
}

export async function getSiteLanguageHint(instanceId: string, phone: string): Promise<"kk" | "ru" | null> {
  return safeRedis(null, async () => {
    const value = await redisClient.get(siteLanguageHintKey(instanceId, phone));
    return value === "kk" || value === "ru" ? value : null;
  });
}

export async function saveSiteLanguageHint(instanceId: string, phone: string, lang: "kk" | "ru"): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(siteLanguageHintKey(instanceId, phone), lang, { EX: SITE_LANG_HINT_TTL_SECONDS });
    return result === "OK";
  });
}

export async function claimReceiptFingerprint(
  instanceId: string,
  fingerprint: string
): Promise<boolean | "error"> {
  // "error" is distinct from false on purpose. safeRedis collapsed a Redis failure into the
  // same false as "this fingerprint is already claimed", and the caller reads false as a
  // duplicate - so during a blip a guest who had just paid was told not to resend a receipt
  // that never reached the operator, with their money already gone. hasReceiptSeen, the
  // discriminator added for exactly this case, is Redis-backed too and returns false in the
  // same outage, so the honest branch was unreachable. Same fix B28 applied to
  // takeComplaintClarification, which was never applied to money (found 2026-08-23).
  try {
    await connectRedis();
    const result = await redisClient.set(receiptFingerprintKey(instanceId, fingerprint), "1", {
      EX: RECEIPT_FINGERPRINT_TTL_SECONDS,
      NX: true,
    });
    return result === "OK";
  } catch {
    return "error";
  }
}

export async function releaseReceiptFingerprint(instanceId: string, fingerprint: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(receiptFingerprintKey(instanceId, fingerprint));
  });
}

export function receiptSeenKey(instanceId: string, orderId: string) {
  return `receipt_seen:${instanceId}:${orderId}`;
}

// Set once the guest's receipt has actually reached the operator card. The hub
// reuses one event name for "confirmed, now pay" and for the "Запросить снова"
// button, so this marker is what tells the two presses apart.
export async function markReceiptSeen(instanceId: string, orderId: string): Promise<boolean> {
  if (!instanceId || !orderId) return false;
  try {
    await connectRedis();
    await redisClient.set(receiptSeenKey(instanceId, orderId), "1", { EX: 24 * 60 * 60 });
    return true;
  } catch {
    return false;
  }
}

export async function hasReceiptSeen(instanceId: string, orderId: string): Promise<boolean> {
  if (!instanceId || !orderId) return false;
  try {
    await connectRedis();
    return Boolean(await redisClient.get(receiptSeenKey(instanceId, orderId)));
  } catch {
    return false;
  }
}

// Photo evidence must not outlive its case, and it must not die before it either.
// whatspro stores every inbound media on arrival (chatwoot:media:{instance}:{messageId})
// and the operator panel renders it from the chat, but that copy lives
// STANDARD_TTL_SECONDS = 24h while an operator case lives CASE_TTL_SECONDS = 7 days. So a
// red "operator needed" row sat on the board for a week with hasMedia:true and nothing
// behind it after the first day - and openbot deleted its own 5-minute scratch copy the
// moment the case was created. Same family as the history-TTL defect: the guests who
// escalated were the ones who lost the evidence (found 2026-08-23).
const CASE_MEDIA_TTL_SECONDS = 7 * 24 * 60 * 60;

export async function saveCaseMedia(
  instanceId: string,
  caseId: string,
  media: { base64: string; mimeType?: string; mediaType?: string; filename?: string }
): Promise<boolean> {
  if (!instanceId || !caseId || !media?.base64) return false;
  return Boolean(
    await safeRedis(false, async () => {
      await redisClient.setEx(
        `operator_case_media:${instanceId}:${caseId}`,
        CASE_MEDIA_TTL_SECONDS,
        JSON.stringify({
          base64: media.base64,
          mimeType: media.mimeType || media.mediaType || "image/jpeg",
          filename: media.filename || "",
          storedAt: Date.now(),
        })
      );
      return true;
    })
  );
}

export async function getCaseMedia(instanceId: string, caseId: string): Promise<Record<string, any> | null> {
  if (!instanceId || !caseId) return null;
  return safeRedis(null, async () => {
    const raw = await redisClient.get(`operator_case_media:${instanceId}:${caseId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
}

export async function saveComplaintMedia(
  instanceId: string,
  phone: string,
  base64: string,
  mimeType: string
): Promise<void> {
  if (!base64) return;
  await safeRedis(undefined, async () => {
    const key = `complaint_media:${instanceId}:${phone}`;
    await redisClient.setEx(key, COMPLAINT_MEDIA_TTL_SECONDS, JSON.stringify({ base64, mimeType }));
  });
}

export async function getComplaintMedia(instanceId: string, phone: string): Promise<Record<string, any> | null> {
  return safeRedis(null, async () => {
    try {
      const data = await redisClient.get(`complaint_media:${instanceId}:${phone}`);
      return data ? JSON.parse(data) : null;
    } catch {
      console.warn("[REDIS] getComplaintMedia read failed", {
        scopeHash: crypto.createHash("sha256").update(`${instanceId}:${phone}`).digest("hex").slice(0, 16),
        code: "COMPLAINT_MEDIA_READ_FAILED",
      });
      return null;
    }
  });
}

export async function clearComplaintMedia(instanceId: string, phone: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(`complaint_media:${instanceId}:${phone}`);
  });
}

// A bare "у меня жалоба" carries nothing an operator can act on. The agent is
// given one turn to ask what happened; this flag guarantees the very next
// message escalates regardless of what it says, so nobody is left waiting.
const COMPLAINT_CLARIFY_TTL_SECONDS = 30 * 60;

function complaintClarifyKey(instanceId: string, phone: string) {
  return `complaint_clarify:${instanceId}:${phone}`;
}

export async function markComplaintClarificationPending(instanceId: string, phone: string, text: string): Promise<boolean> {
  return safeRedis(false, async () => {
    const result = await redisClient.set(complaintClarifyKey(instanceId, phone), String(text || "").slice(0, 900), {
      EX: COMPLAINT_CLARIFY_TTL_SECONDS,
    });
    return result === "OK";
  });
}

export async function takeComplaintClarification(
  instanceId: string,
  phone: string
): Promise<string | null | "error"> {
  // "error" is distinct from null on purpose. safeRedis used to collapse a Redis failure
  // into the same null as an empty key, so callers could not tell "nothing pending" from
  // "we could not read" - the route re-asked its clarifying question during an outage and
  // the AI-tool lane did the same, instead of failing open toward a human (found
  // 2026-08-23).
  try {
    await connectRedis();
    const key = complaintClarifyKey(instanceId, phone);
    const value = await redisClient.get(key);
    if (value === null || value === undefined) return null;
    await redisClient.del(key).catch(() => undefined);
    return String(value);
  } catch {
    return "error";
  }
}

export async function hasComplaintClarificationPending(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => Boolean(await redisClient.get(complaintClarifyKey(instanceId, phone))));
}

export async function saveDailyLog(instanceId: string, logData: Record<string, any>): Promise<void> {
  await safeRedis(undefined, async () => {
    const key = `daily_logs:${instanceId}`;
    try {
      // One entry per CRM update per guest turn, each carrying free-text
      // psycho_analysis, and only the 48h TTL bounded it - multi-megabyte on a busy
      // tenant, read by nothing (the analytics cron reads the hub's CRM instead).
      // Trimmed in the same pipeline so the list cannot outgrow its usefulness
      // (found 2026-08-22).
      await redisClient.multi()
        .rPush(key, JSON.stringify(logData))
        .lTrim(key, -DAILY_LOG_MAX_ITEMS, -1)
        .expire(key, DAILY_LOG_TTL_SECONDS)
        .exec();
    } catch (error: any) {
      console.error(`[REDIS] Daily log save failed (${instanceId}):`, error?.message || error);
    }
  });
}

export async function saveKitchenStatus(
  instanceId: string,
  value: Record<string, any>
): Promise<KitchenStatusState> {
  const previous = await getKitchenStatus(instanceId).catch(() => null);
  const status = normalizeKitchenStatus(value, previous);
  await safeRedis(undefined, async () => {
    await redisClient.setEx(kitchenStatusKey(instanceId), KITCHEN_STATUS_TTL_SECONDS, JSON.stringify(status));
  });
  return status;
}

export async function getKitchenStatus(instanceId: string): Promise<KitchenStatusState | null> {
  return safeRedis(null, async () => {
    const raw = await redisClient.get(kitchenStatusKey(instanceId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const current = normalizeKitchenStatus(parsed && typeof parsed === "object" ? parsed : {});
    if (current.reset_at > 0 && current.reset_at <= Math.floor(Date.now() / 1000)) {
      const reset = normalizeKitchenStatus({
        wait_time: 0,
        is_emergency: false,
        delivery: true,
        pickup: true,
        reset_at: 0,
        payment_details: current.payment_details,
        // The pause expiring says nothing about the clock: a restaurant that was
        // outside its working hours still is.
        within_work_hours: current.within_work_hours,
        is_accepting_orders: current.within_work_hours,
        closed_reason: current.within_work_hours ? "" : current.closed_reason,
        source: "redis_kitchen_status_reset",
      });
      await redisClient.setEx(kitchenStatusKey(instanceId), KITCHEN_STATUS_TTL_SECONDS, JSON.stringify(reset));
      return reset;
    }
    return current;
  });
}

export async function hasMagicLinkBeenSent(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => Boolean(await redisClient.get(magicLinkKey(instanceId, phone))));
}

/**
 * When the last link was issued to this guest, as an epoch millisecond value,
 * or 0 when none was. The boolean flag above cannot tell "sent five minutes
 * ago" from "sent three weeks ago", and the guest who asks again on the same
 * day must be pointed at the link they already have instead of receiving a
 * fresh URL every time.
 */
export async function getMagicLinkSentAt(instanceId: string, phone: string): Promise<number> {
  return safeRedis(0, async () => Number(await redisClient.get(magicLinkKey(instanceId, phone))) || 0);
}

export async function markMagicLinkSent(instanceId: string, phone: string): Promise<boolean> {
  return safeRedis(false, async () => {
    await redisClient.setEx(magicLinkKey(instanceId, phone), MAGIC_LINK_SENT_TTL_SECONDS, String(Date.now()));
    return true;
  });
}

function parseShiftNoteRecord(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return { text: "", plain: false, expired: false, expiresAt: 0 };
  try {
    const parsed = JSON.parse(text);
    const expiresAt = Number(parsed?.expiresAt || parsed?.expires_at || 0);
    return {
      text: String(parsed?.text || "").trim(),
      plain: false,
      expired: Boolean(expiresAt && expiresAt <= Date.now()),
      expiresAt,
    };
  } catch {
    return { text, plain: true, expired: false, expiresAt: 0 };
  }
}

/**
 * Erase a deleted note's trace from everything the next turn will read.
 *
 * "Заметканы өшіргенде миынан жоғалтып жіберу" (owner, 2026-08-28). Deleting the
 * Redis key is not enough: the sentence the note produced lives on in three other
 * places the prompt is built from, and any one of them puts the retired restriction
 * back in front of the guest.
 *
 * 1. OpenBot's own history rows, tagged with sourceNoteIds when they were written.
 * 2. The GATEWAY timeline (chatwoot:history:*). getChatHistory merges both lists,
 *    and the gateway copy carries no sourceNoteIds - it is the same assistant text
 *    mirrored by the transport - so it survived every purge and kept telling the
 *    model pizza was unavailable after the operator had removed the note. Matched
 *    by exact text of the rows we just removed, which is the only key the two
 *    copies share.
 * 3. The rolling summary, which is derived from that history.
 */
async function purgeShiftNoteIdsFromHistory(instanceId: string, noteIds: string[]): Promise<number> {
  const ids = new Set(noteIds.map(String).filter(Boolean));
  if (!ids.size) return 0;
  let removedTotal = 0;
  const purgedTexts = new Set<string>();
  const keys = await scanKeys(`history:${instanceId}:*`);
  for (const key of keys) {
    const ttlBefore = await redisClient.ttl(key).catch(() => -1);
    const rows = await redisClient.lRange(key, 0, -1).catch(() => []);
    const kept = rows.filter((raw) => {
      try {
        const entry = JSON.parse(raw);
        const sourceNoteIds = Array.isArray(entry?.sourceNoteIds) ? entry.sourceNoteIds.map(String) : [];
        const noteDerived = sourceNoteIds.some((id: string) => ids.has(id));
        if (noteDerived) {
          const text = String(entry?.text || entry?.body || "").trim();
          if (text) purgedTexts.add(text);
        }
        return !noteDerived;
      } catch { return true; }
    });
    const removed = rows.length - kept.length;
    if (!removed) continue;
    const multi = redisClient.multi().del(key);
    kept.forEach((row) => multi.rPush(key, row));
    await multi.exec();
    // A key that arrived with no readable TTL used to come back from the rebuild
    // immortal, because the restore was skipped entirely. Fall back to the 7-day
    // window instead of leaving a history list to live forever (found 2026-08-22).
    if (kept.length) await redisClient.expire(key, ttlBefore > 0 ? ttlBefore : CHAT_HISTORY_TTL_SECONDS);
    // The rolling summary is written from this history, so a note that was
    // just deleted survives inside it ("pizza was unavailable") and reaches
    // the prompt again long after the operator removed it. The summary is a
    // derived cache: dropping it makes the next turn rebuild it from what is
    // actually left, which is the only state the guest may hear about.
    await redisClient.del(key.replace(/^history:/, "conv_summary:")).catch(() => undefined);
    removedTotal += removed;
  }

  // The gateway timeline holds the same sentences without the note tag, and
  // getChatHistory merges it into recent_dialog. Left alone, the retired note keeps
  // arguing its case in the prompt.
  if (purgedTexts.size) {
    const mirrorKeys = await scanKeys(`chatwoot:history:${instanceId}:*`).catch(() => []);
    for (const key of mirrorKeys) {
      const ttlBefore = await redisClient.ttl(key).catch(() => -1);
      const rows = await redisClient.lRange(key, 0, -1).catch(() => []);
      const kept = rows.filter((raw) => {
        try {
          const entry = JSON.parse(raw);
          const text = String(entry?.text || entry?.body || "").trim();
          return !text || !purgedTexts.has(text);
        } catch { return true; }
      });
      const removed = rows.length - kept.length;
      if (!removed) continue;
      const multi = redisClient.multi().del(key);
      kept.forEach((row) => multi.rPush(key, row));
      await multi.exec();
      if (kept.length) await redisClient.expire(key, ttlBefore > 0 ? ttlBefore : CHAT_HISTORY_TTL_SECONDS);
      await redisClient.del(`conv_summary:${instanceId}:${key.split(":").pop()}`).catch(() => undefined);
      removedTotal += removed;
    }
  }
  return removedTotal;
}

export async function scanKeys(pattern: string): Promise<string[]> {
  await connectRedis();
  const keys: string[] = [];
  for await (const chunk of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
    if (Array.isArray(chunk)) keys.push(...chunk.map(String));
    else keys.push(String(chunk));
  }
  return keys;
}

const SHIFT_NOTE_DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Parses whatever expiry format the DLE site sends into a TTL.
 *
 * The hidden bug: a Unix timestamp in SECONDS ("1785400000") goes through
 * Date.parse as garbage (NaN in V8), so every note with an epoch expiry
 * silently lived the default 24h instead of its real lifetime. Numeric strings
 * are now detected explicitly: >=1e12 is treated as milliseconds, >=1e9 as
 * seconds; anything else falls back to Date.parse; unreadable values fall back
 * to the 24h default.
 *
 * A timestamp that is already in the past returns 0: the operator meant the note
 * to be over, and defaulting it to a full day kept a stale restriction alive for
 * 24 hours (audit, 2026-08-12). Only an unreadable expiry gets the default.
 */
export function resolveShiftNoteTtlSeconds(expiresAtString?: string, nowMs = Date.now()): number {
  const raw = String(expiresAtString || "").trim();
  if (!raw) return SHIFT_NOTE_DEFAULT_TTL_SECONDS;
  let expiresAtMs = 0;
  if (/^\d{10,16}$/.test(raw)) {
    const numeric = Number(raw);
    expiresAtMs = numeric >= 1e12 ? numeric : numeric * 1000;
  } else {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) expiresAtMs = parsed;
  }
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return SHIFT_NOTE_DEFAULT_TTL_SECONDS;
  if (expiresAtMs <= nowMs) return 0;
  return Math.max(60, Math.ceil((expiresAtMs - nowMs) / 1000));
}

export async function saveShiftNote(
  instanceId: string,
  noteId: string | number | undefined,
  text: string,
  expiresAtString?: string
): Promise<boolean> {
  const noteText = String(text || "").trim();
  if (!noteText) return false;
  return safeRedis(false, async () => {
    const safeNoteId =
      String(noteId || "").trim() ||
      `fallback_${crypto.createHash("sha1").update(`${instanceId}|${noteText}|${expiresAtString || ""}`).digest("hex").slice(0, 16)}`;

    const ttlSeconds = resolveShiftNoteTtlSeconds(expiresAtString);
    // An expiry already in the past means the note is over before it arrives.
    // Storing it would restrict the menu for a shift that has ended.
    if (ttlSeconds <= 0) return false;

    await redisClient.setEx(
      `shift_note:${instanceId}:${safeNoteId}`,
      ttlSeconds,
      JSON.stringify({ text: noteText, createdAt: Date.now(), expiresAt: Date.now() + ttlSeconds * 1000 })
    );
    return true;
  });
}

export async function deleteShiftNote(
  instanceId: string,
  noteId?: string | number,
  text = ""
): Promise<number> {
  return safeRedis(0, async () => {
    const safeNoteId = String(noteId || "").trim();
    const expectedText = String(text || "").trim().toLowerCase();
    const deletedIds: string[] = [];
    const deleteKey = async (key: string) => {
      if (await redisClient.del(key)) deletedIds.push(key.split(":").pop() || "");
    };
    // A delete must name its target: the note id, or failing that the exact text
    // of one note. Nothing else is removed. The previous fallback wiped every
    // note of the instance when neither was supplied, so one malformed webhook
    // erased a whole shift and the agent kept answering from stale memory.
    if (safeNoteId && safeNoteId !== "0") await deleteKey(`shift_note:${instanceId}:${safeNoteId}`);
    if (!deletedIds.length && expectedText) {
      const keys = await scanKeys(`shift_note:${instanceId}:*`);
      for (const key of keys) {
        const stored = parseShiftNoteRecord((await redisClient.get(key).catch(() => "")) || "");
        if (stored.text.toLowerCase().trim() === expectedText) await deleteKey(key);
      }
    }
    await purgeShiftNoteIdsFromHistory(instanceId, deletedIds);
    // The count is what lets the webhook stop answering "note removed" when it
    // removed nothing at all (audit, 2026-08-12).
    return deletedIds.length;
  });
}

/**
 * A note deleted on the site must vanish from EVERY copy the bot reads, at once.
 *
 * Live test 2026-10-04: «суши жоқ» was deleted, the webhook removed the Redis note
 * (deleted=1), and the very next question still got «суши уақытша дайындалмай тұр»:
 * the turn read the hub runtime snapshot (30 s stale-while-revalidate), which still
 * listed the note, and mergeShiftNoteSources put it straight back. A short-lived
 * tombstone now blocks the id in every lane (snapshots, hub re-sync, history), and
 * the snapshots themselves are dropped so the next turn reads the hub fresh.
 */
const DELETED_NOTE_TTL_SECONDS = 30 * 60;
function deletedNotesKey(instanceId: string) {
  return `shift_note_deleted:${instanceId}`;
}

export async function getDeletedShiftNoteIds(instanceId: string): Promise<Set<string>> {
  return safeRedis(new Set<string>(), async () => {
    const rows = await redisClient.hGetAll(deletedNotesKey(instanceId));
    const now = Date.now();
    return new Set(
      Object.entries(rows || {})
        .filter(([, at]) => now - Number(at || 0) < DELETED_NOTE_TTL_SECONDS * 1000)
        .map(([id]) => id),
    );
  });
}

function noteIdOf(note: any) {
  return String(note?.noteId ?? note?.note_id ?? note?.id ?? "").trim();
}

export function withoutDeletedNotes<T>(list: T[], ids: Set<string>, text = ""): T[] {
  const expected = String(text || "").trim().toLowerCase();
  return (Array.isArray(list) ? list : []).filter((note: any) => {
    const id = noteIdOf(note);
    if (id && ids.has(id)) return false;
    if (expected && String(note?.text || "").trim().toLowerCase() === expected) return false;
    return true;
  });
}

/** Drop the short-lived hub runtime snapshots so the next turn reads the hub fresh. */
export async function invalidateRuntimeSnapshots(instanceId: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del([`runtime_status:${instanceId}`, `runtime_status_swr:${instanceId}`]);
  });
}

/**
 * A note created or edited on the site: the old runtime snapshot (old text under the
 * same id wins the merge) is dropped, and an id the operator brought back is no
 * longer treated as deleted.
 */
export async function refreshAfterShiftNoteSaved(instanceId: string, noteId?: string | number): Promise<void> {
  const id = String(noteId || "").trim();
  await safeRedis(undefined, async () => {
    if (id) await redisClient.hDel(deletedNotesKey(instanceId), id);
  });
  await invalidateRuntimeSnapshots(instanceId);
}

export async function forgetDeletedShiftNote(instanceId: string, noteId?: string | number, text = ""): Promise<void> {
  await safeRedis(undefined, async () => {
    const id = String(noteId || "").trim();
    const ids = new Set(id && id !== "0" ? [id] : []);
    const expectedText = String(text || "").trim();
    if (!ids.size && !expectedText) return;
    if (ids.size) {
      await redisClient.multi()
        .hSet(deletedNotesKey(instanceId), id, String(Date.now()))
        .expire(deletedNotesKey(instanceId), DELETED_NOTE_TTL_SECONDS)
        .exec();
    }
    // Short-lived hub snapshots are simply dropped: the next turn reads the hub fresh.
    await invalidateRuntimeSnapshots(instanceId);
    // The 10-minute backup is the outage fallback - keep it, minus the deleted note.
    const backupKey = `runtime_status_backup:${instanceId}`;
    const raw = await redisClient.get(backupKey).catch(() => null);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.shift_notes)) {
          parsed.shift_notes = withoutDeletedNotes(parsed.shift_notes, ids, expectedText);
          await redisClient.set(backupKey, JSON.stringify(parsed), { KEEPTTL: true });
        }
      } catch { /* a malformed backup is left for its TTL */ }
    }
    if (ids.size) {
      await purgeShiftNoteIdsFromHistory(instanceId, [...ids]).catch(() => 0);
      // A turn already in flight when the delete arrived may still save a reply
      // built on the old note; sweep once more after it has finished.
      setTimeout(() => {
        void purgeShiftNoteIdsFromHistory(instanceId, [...ids]).catch(() => 0);
      }, 90_000).unref?.();
    }
  });
}

export async function getActiveShiftNotes(instanceId: string): Promise<Array<{ noteId: string; text: string; expiresAt?: number }>> {
  return safeRedis([], async () => {
    const keys = await scanKeys(`shift_note:${instanceId}:*`);
    const deleted = await getDeletedShiftNoteIds(instanceId);
    const notes = [];
    for (const key of keys) {
      if (deleted.has(key.split(":").pop() || "")) {
        await redisClient.del(key).catch(() => undefined);
        continue;
      }
      const note = parseShiftNoteRecord((await redisClient.get(key)) || "");
      if (!note.text || note.expired || note.plain) {
        const noteId = key.split(":").pop() || "";
        await redisClient.del(key).catch(() => undefined);
        // An explicit delete purges the note's trace from history and the rolling
        // summary; expiry used to drop only the key, so the summary kept telling
        // the next turn that drinks were unavailable for another 30 days.
        if (noteId) await purgeShiftNoteIdsFromHistory(instanceId, [noteId]).catch(() => undefined);
        continue;
      }
      notes.push({ noteId: key.split(":").pop() || "", text: note.text, expiresAt: note.expiresAt || undefined });
    }
    return notes;
  });
}

export async function syncShiftNotesSnapshot(
  instanceId: string,
  snapshot: Array<{ id?: unknown; note_id?: unknown; noteId?: unknown; text?: unknown; expires_at?: unknown; expiresAt?: unknown }>
): Promise<number> {
  return safeRedis(0, async () => {
    const desiredIds = new Set<string>();
    // A hub snapshot fetched just before (or cached across) a site delete must not
    // resurrect the note the operator has just removed.
    const deleted = await getDeletedShiftNoteIds(instanceId);
    for (const note of Array.isArray(snapshot) ? snapshot : []) {
      const noteId = String(note?.noteId ?? note?.note_id ?? note?.id ?? "").trim();
      const text = String(note?.text || "").trim();
      if (!noteId || !text || deleted.has(noteId)) continue;
      const expiresAt = note?.expiresAt ?? note?.expires_at;
      const expiry = typeof expiresAt === "number" && expiresAt > 0
        ? new Date(expiresAt >= 1e12 ? expiresAt : expiresAt * 1000).toISOString()
        : String(expiresAt || "");
      if (await saveShiftNote(instanceId, noteId, text, expiry)) desiredIds.add(noteId);
    }

    // Track which note ids the hub itself has ever listed. Only those may be
    // revoked by a later snapshot: a hub that echoes shift_notes: [] while its
    // own panel notes travel by webhook used to erase every Redis note within
    // one poll (live round, 2026-08-24), and a "hub once sent notes" flag alone
    // brought the same wipe back the moment the operator cleared the panel.
    // Notes the hub has NEVER listed belong to the webhook lane - explicit
    // shift_note_deleted events and the TTL decide their fate.
    const hubSeenKey = `shift_notes_hub_seen:${instanceId}`;
    for (const id of desiredIds) {
      await redisClient.sAdd(hubSeenKey, id).catch(() => undefined);
    }
    await redisClient.expire(hubSeenKey, 7 * 24 * 3600).catch(() => undefined);

    let changed = 0;
    const existingKeys = await scanKeys(`shift_note:${instanceId}:*`);
    for (const key of existingKeys) {
      const noteId = key.split(":").pop() || "";
      if (!noteId || desiredIds.has(noteId)) continue;
      const knownToHub = await redisClient.sIsMember(hubSeenKey, noteId).catch(() => false);
      if (!knownToHub) continue;
      changed += await deleteShiftNote(instanceId, noteId);
    }
    return changed + desiredIds.size;
  });
}

export async function getJsonCache<T>(key: string): Promise<T | null> {
  return safeRedis<T | null>(null, async () => {
    const raw = await redisClient.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  });
}

export async function setJsonCache(key: string, ttlSeconds: number, value: unknown): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
  });
}

export async function deleteCache(key: string): Promise<void> {
  await safeRedis(undefined, async () => {
    await redisClient.del(key);
  });
}

import http from "node:http";
import https from "node:https";
import net from "node:net";
import * as dnsCallback from "node:dns";
import dns from "node:dns/promises";
import {
  deleteCache,
  getJsonCache,
  getKitchenStatus,
  saveDailyLog,
  saveKitchenStatus,
  setJsonCache,
  type KitchenStatusState,
} from "./redis.service.js";
import { auditError } from "./auditLogger.service.js";
import { callAlemiLegacyAction } from "./alemiApi.service.js";

const GROUP_OR_STATUS_RE = /(@g\.us$|^status@broadcast$)/i;
const PHONE_JID_RE = /@(c\.us|s\.whatsapp\.net)$/i;
const LID_JID_RE = /@lid$/i;

function normalizeIp(ip: string) {
  return String(ip || "").replace(/^::ffff:/i, "");
}

export function isPrivateIp(ipValue: string) {
  const ip = normalizeIp(ipValue).toLowerCase();

  if (!net.isIP(ip)) return false;

  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:")) return true;

  if (ip === "127.0.0.1" || ip === "0.0.0.0") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("169.254.")) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return true;

  return false;
}

function safeLookup(hostname: string, options: any, callback: any) {
  dnsCallback.lookup(hostname, options, (error, address, family) => {
    if (error) return callback(error);
    if (isPrivateIp(address)) return callback(new Error("PRIVATE_DNS_BLOCKED"));
    return callback(null, address, family);
  });
}

export const safeHttpAgent = new http.Agent({ keepAlive: false, lookup: safeLookup });
export const safeHttpsAgent = new https.Agent({ keepAlive: false, lookup: safeLookup });

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

export function normalizeKazakhstanPhone(digits: unknown) {
  if (!digits) return "";

  let phone = String(digits).replace(/\D/g, "");
  if (phone.startsWith("00")) phone = phone.slice(2);
  if (phone.length === 10) phone = `7${phone}`;
  if (phone.startsWith("8") && phone.length === 11) phone = `7${phone.slice(1)}`;

  return /^7\d{10}$/.test(phone) ? phone : "";
}

export function isGroupOrStatusJid(value: unknown) {
  const raw = String(value || "").trim().toLowerCase();
  return GROUP_OR_STATUS_RE.test(raw);
}

export function extractPhoneCandidate(rawValue: unknown) {
  const raw = String(rawValue || "").trim();
  if (!raw || isGroupOrStatusJid(raw)) return "";

  if (LID_JID_RE.test(raw)) return "";

  const phoneLikeMatch =
    raw.match(/(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}/) ||
    raw.match(/\d{10,15}/);

  return phoneLikeMatch ? phoneLikeMatch[0] : "";
}

export function normalizePhone(value: unknown = "") {
  return normalizeKazakhstanPhone(extractPhoneCandidate(value));
}

export function normalizePhoneFromCandidates(candidates: unknown[] = []) {
  for (const candidate of candidates) {
    const phone = normalizePhone(candidate);
    if (phone) return phone;
  }

  return "";
}

export function getPhoneCandidatesFromWebhook(data: Record<string, any> = {}, eventData: Record<string, any> = {}, key: Record<string, any> = {}) {
  return [
    eventData.normalizedPhone,
    data.normalizedPhone,
    eventData.senderPhone,
    data.senderPhone,
    eventData.phone,
    data.phone,
    typeof eventData.sender === "string" ? eventData.sender : "",
    typeof data.sender === "string" ? data.sender : "",
    key.participant,
    key.remoteJid,
    key.id?.remote,
  ];
}

export function toWhatsAppChatId(value: unknown, jidLookup: Map<string, string> | null = null) {
  const raw = String(value || "").trim();
  if (!raw || isGroupOrStatusJid(raw)) return "";

  const phone = normalizePhone(raw);
  if (phone && jidLookup && jidLookup.has(phone)) return jidLookup.get(phone) || "";
  if (PHONE_JID_RE.test(raw) || LID_JID_RE.test(raw)) return raw;
  if (phone) return `${phone}@c.us`;

  return "";
}

export async function normalizePublicDomain(rawDomain = "") {
  const input = String(rawDomain || "").trim();
  if (!input || input.length > 255) throw new Error("BAD_DOMAIN");

  const parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("BAD_DOMAIN_PROTOCOL");
  if (parsed.username || parsed.password) throw new Error("BAD_DOMAIN_AUTH");

  const host = parsed.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("LOCAL_DOMAIN_BLOCKED");
  }

  if (net.isIP(host) && isPrivateIp(host)) {
    throw new Error("PRIVATE_IP_BLOCKED");
  }

  const records = await Promise.race([
    dns.lookup(host, { all: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("DNS_TIMEOUT")), 5000)),
  ]);
  if (!records.length || records.some((record) => isPrivateIp(record.address))) {
    throw new Error("PRIVATE_DNS_BLOCKED");
  }

  return `${parsed.protocol}//${parsed.host}`;
}

async function apiBot(
  domain: string,
  payload: Record<string, any>,
  timeout = 10000,
  options: { config?: Record<string, any> | null } = {}
) {
  const instanceId = String(payload.restaurant_id || payload.instance || payload.instanceId || "").trim();
  if (!instanceId) throw new Error("ALEMI_INSTANCE_NOT_CONFIGURED");
  void domain;
  // `config` is spread conditionally: callAlemiCommand reads the tenant config
  // itself when the key is absent, but treats an explicit `undefined` as "the
  // caller already resolved it", which would strip the credential.
  return callAlemiLegacyAction(payload.action, payload, {
    timeoutMs: timeout,
    ...(options.config ? { config: options.config } : {}),
  });
}

function toBool(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function safeJsonObject(value: unknown, fallback: any = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string" || !value.trim()) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizePaymentDetails(value: unknown): Array<{ label: string; value: string; source?: string }> {
  const raw = Array.isArray(value) ? value : [];
  return raw
    .map((item) => ({
      label: String(item?.label || item?.name || "").trim().slice(0, 80),
      value: String(item?.value || item?.number || item?.link || "").trim().slice(0, 240),
      source: item?.source ? String(item.source) : undefined,
    }))
    .filter((item) => item.label && item.value);
}

// `a || b || c` over arrays is dead code: [] is truthy, so an empty top-level
// payment_details won the chain and the requisites the operator types into the
// site's kitchen settings screen - which hub returns nested under
// kitchen_status.payment_details - were never read. On the money path the guest
// was told "реквизиттер бапталмаған" while the site did have them. The chain
// keeps its order and now picks the first entry that normalizes to a non-empty
// list.
function firstPaymentDetails(...values: unknown[]) {
  for (const value of values) {
    const normalized = normalizePaymentDetails(value);
    if (normalized.length) return normalized;
  }
  return [];
}

function firstFiniteNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === "" || value === null || value === undefined) continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

export function normalizeRuntimeStatus(data: Record<string, any> = {}) {
  const settings = safeJsonObject(data.settings, {});
  const rawKitchenSettings = safeJsonObject(settings.kitchen_status, null);
  const current = safeJsonObject(
    data.current || safeJsonObject(data.runtime, {}).current || safeJsonObject(data.runtime_status, {}).current,
    null,
  );
  const nested =
    safeJsonObject(data.runtime_status, null) ||
    current ||
    safeJsonObject(data.kitchen_status, null) ||
    safeJsonObject(data.status, null) ||
    data;
  const kitchen = safeJsonObject(nested.kitchen_status || nested.kitchen || nested.settings || nested.current || nested, {});
  const waitTime = firstFiniteNumber(
    kitchen.wait_time, kitchen.wait_minutes, kitchen.current_wait_minutes, kitchen.current_wait_time,
    nested.wait_time, nested.wait_minutes, nested.current_wait_minutes, nested.current_wait_time,
    data.wait_time, data.wait_minutes, data.current_wait_minutes, data.current_wait_time,
  );
  const resetAt = Number(kitchen.reset_at ?? nested.reset_at ?? data.reset_at ?? 0) || 0;
  const delivery = toBool(kitchen.delivery ?? kitchen.delivery_enabled ?? nested.delivery ?? nested.delivery_enabled ?? data.delivery ?? data.delivery_enabled, true);
  const pickup = toBool(kitchen.pickup ?? kitchen.pickup_enabled ?? nested.pickup ?? nested.pickup_enabled ?? data.pickup ?? data.pickup_enabled, true);
  const isEmergency = toBool(kitchen.is_emergency ?? kitchen.emergency ?? nested.is_emergency ?? nested.emergency ?? data.is_emergency ?? data.emergency, false);
  const fetchedWaitTime = rawKitchenSettings
    ? firstFiniteNumber(rawKitchenSettings.wait_time, rawKitchenSettings.wait_minutes, rawKitchenSettings.current_wait_minutes)
    : waitTime;
  const fetchedEmergency = rawKitchenSettings ? toBool(rawKitchenSettings.is_emergency, false) : isEmergency;

  return {
    is_accepting_orders: toBool(nested.is_accepting_orders ?? data.is_accepting_orders, true),
    within_work_hours: toBool(nested.within_work_hours ?? data.within_work_hours, true),
    closed_reason: String(nested.closed_reason || data.closed_reason || "").trim(),
    delivery,
    pickup,
    wait_time: waitTime,
    reset_at: resetAt,
    is_emergency: isEmergency,
    kitchen_status: {
      wait_time: waitTime,
      reset_at: resetAt,
      delivery,
      pickup,
      is_emergency: isEmergency,
    },
    fetched_settings: {
      wait_time: fetchedWaitTime,
      is_emergency: fetchedEmergency,
      source: rawKitchenSettings ? "settings.kitchen_status" : current ? "current" : "runtime.status.get",
    },
    payment_details: firstPaymentDetails(data.payment_details, nested.payment_details, kitchen.payment_details),
    source: data.source || "dle_spa_settings",
    fetched_at: new Date().toISOString(),
  };
}

export function runtimeFromKitchenStatus(instanceId: string, status: KitchenStatusState): Record<string, any> {
  // within_work_hours used to be hard-coded true here, so whenever the hub was
  // unreachable a closed restaurant looked open and the bot sold through the
  // night (audit, 2026-08-12). The record now carries the openness the last hub
  // read stored, and the local pause is applied on top of it.
  const withinWorkHours = status.within_work_hours !== false;
  const isAcceptingOrders =
    withinWorkHours && status.is_accepting_orders !== false && !status.is_emergency && (status.delivery || status.pickup);
  const closedReason = !withinWorkHours
    ? status.closed_reason || "outside_work_hours"
    : status.is_emergency
      ? "emergency_stop"
      : !status.delivery && !status.pickup
        ? "service_channels_disabled"
        : "";

  return {
    is_accepting_orders: isAcceptingOrders,
    within_work_hours: withinWorkHours,
    closed_reason: closedReason,
    delivery: status.delivery,
    pickup: status.pickup,
    wait_time: status.wait_time,
    reset_at: status.reset_at,
    is_emergency: status.is_emergency,
    kitchen_status: {
      wait_time: status.wait_time,
      reset_at: status.reset_at,
      delivery: status.delivery,
      pickup: status.pickup,
      is_emergency: status.is_emergency,
      source: status.source,
      synced_at: status.synced_at,
    },
    fetched_settings: {
      wait_time: status.wait_time,
      is_emergency: status.is_emergency,
      source: status.source || "redis_kitchen_status",
    },
    payment_details: status.payment_details,
    source: status.source || "redis_kitchen_status",
    restaurant_id: instanceId,
    fetched_at: status.synced_at,
    redis_runtime_fallback: true,
  };
}

// Kitchen state the panel pushes to /kanban-webhook lands in Redis, but Redis was
// only ever read when the hub was unreachable - so while the hub answered (which
// is almost always) an operator who paused the kitchen or raised the wait changed
// nothing the guest could see (audit, 2026-08-12). The push is now overlaid on the
// hub read, under two rules that keep it from ever overselling or outliving its
// welcome: it must still be in effect (an explicit reset_at in the future, or
// pushed within the last PUSHED_KITCHEN_GRACE_MS), and it may only make the state
// MORE restrictive - a longer wait, emergency on, a channel off. A hub value that
// is already stricter wins.
const PUSHED_KITCHEN_GRACE_MS = 30 * 60_000;
const HUB_KITCHEN_SOURCES = ["dle_runtime_status", "redis_kitchen_status_reset"];

export function overlayPushedKitchenState(
  status: Record<string, any>,
  pushed: KitchenStatusState | null | undefined,
  nowMs = Date.now(),
): Record<string, any> {
  if (!pushed) return status;
  if (HUB_KITCHEN_SOURCES.includes(String(pushed.source || "").trim())) return status;
  const nowSeconds = Math.floor(nowMs / 1000);
  const stillScheduled = Number(pushed.reset_at || 0) > nowSeconds;
  const pushedAt = Date.parse(String(pushed.synced_at || "")) || 0;
  const stillFresh = pushedAt > 0 && nowMs - pushedAt <= PUSHED_KITCHEN_GRACE_MS;
  if (!stillScheduled && !stillFresh) return status;

  const waitTime = Math.max(Number(status.wait_time || 0) || 0, Number(pushed.wait_time || 0) || 0);
  const isEmergency = Boolean(status.is_emergency) || Boolean(pushed.is_emergency);
  const delivery = Boolean(status.delivery) && Boolean(pushed.delivery);
  const pickup = Boolean(status.pickup) && Boolean(pushed.pickup);
  const resetAt = stillScheduled ? Number(pushed.reset_at || 0) : Number(status.reset_at || 0) || 0;
  const changed =
    waitTime !== (Number(status.wait_time || 0) || 0) ||
    isEmergency !== Boolean(status.is_emergency) ||
    delivery !== Boolean(status.delivery) ||
    pickup !== Boolean(status.pickup) ||
    resetAt !== (Number(status.reset_at || 0) || 0);
  if (!changed) return status;

  return {
    ...status,
    wait_time: waitTime,
    is_emergency: isEmergency,
    delivery,
    pickup,
    reset_at: resetAt,
    is_accepting_orders: Boolean(status.is_accepting_orders) && !isEmergency && (delivery || pickup),
    kitchen_status: {
      ...(status.kitchen_status || {}),
      wait_time: waitTime,
      is_emergency: isEmergency,
      delivery,
      pickup,
      reset_at: resetAt,
    },
    fetched_settings: {
      ...(status.fetched_settings || {}),
      wait_time: Math.max(Number(status.fetched_settings?.wait_time || 0) || 0, waitTime),
      is_emergency: isEmergency,
    },
    pushed_kitchen_override: true,
    pushed_kitchen_source: String(pushed.source || "redis_kitchen_status"),
  };
}

export async function getRuntimeStatus(
  instanceId: string,
  domain: string,
  options: { forceFresh?: boolean } = {}
): Promise<Record<string, any> | null> {
  const cacheKey = `runtime_status:${instanceId}`;
  const backupKey = `runtime_status_backup:${instanceId}`;

  if (!options.forceFresh) {
    const cached = await getJsonCache<Record<string, any>>(cacheKey);
    if (cached) return cached;
  }

  try {
    const data = await apiBot(domain, { action: "get_runtime_status", restaurant_id: instanceId }, 8000);
    // Read the pushed state BEFORE the sync below overwrites it with the hub's.
    const pushed = await getKitchenStatus(instanceId).catch(() => null);
    const status = overlayPushedKitchenState(normalizeRuntimeStatus(data || {}), pushed);
    await setJsonCache(cacheKey, 5, status);
    await setJsonCache(backupKey, 600, status);
    await saveKitchenStatus(instanceId, {
      ...(status.kitchen_status || {}),
      payment_details: status.payment_details || [],
      // Openness travels with the record, so the Redis fallback can reproduce a
      // closed restaurant instead of assuming an open one.
      is_accepting_orders: status.is_accepting_orders,
      within_work_hours: status.within_work_hours,
      closed_reason: status.closed_reason || "",
      // Keeping the push's own source is what lets the override survive the very
      // sync that would otherwise erase it one turn later.
      source: status.pushed_kitchen_override ? status.pushed_kitchen_source : "dle_runtime_status",
      preserve_reset: true,
    }).catch((syncError: any) => {
      auditError("Runtime Redis kitchen sync skipped", syncError, { instanceId });
    });
    return status;
  } catch (error: any) {
    auditError("DLE runtime status read failed", error, { instanceId, domain });
    const redisKitchen = await getKitchenStatus(instanceId);
    if (redisKitchen) {
      const redisRuntime = runtimeFromKitchenStatus(instanceId, redisKitchen);
      await setJsonCache(cacheKey, 5, redisRuntime).catch(() => undefined);
      return redisRuntime;
    }

    const backup = await getJsonCache<Record<string, any>>(backupKey);
    if (!backup) return null;
    return {
      ...backup,
      source: `${backup.source || "dle_spa_settings"}_stale_backup`,
      stale_runtime_backup: true,
      wait_time: 0,
      reset_at: 0,
      kitchen_status: {
        ...(backup.kitchen_status || {}),
        wait_time: 0,
        reset_at: 0,
      },
    };
  }
}

function localizedOrderText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, any>;
  for (const candidate of [record.ru, record.kk, record.kz, record.name, record.title, record.value]) {
    const text = localizedOrderText(candidate);
    if (text) return text;
  }
  return "";
}

function normalizeOrderItems(items: unknown) {
  let raw = items;
  if (typeof items === "string") {
    try {
      raw = JSON.parse(items);
    } catch {
      raw = [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 50)
    .map((item) => ({
      id: Number(item?.id || item?.product_id || item?.item_id || 0) || 0,
      name: localizedOrderText(
        item?.name || item?.title || item?.product_name || item?.product?.name || item?.product?.title,
      ).slice(0, 120),
      qty: Number(item?.qty || item?.count || item?.quantity || 1) || 1,
      price: Number(item?.price || item?.amount || 0) || 0,
      total: Number(item?.total || item?.sum || 0) || 0,
      comment: String(item?.comment || item?.note || "").trim().slice(0, 240),
    }))
    .filter((item) => item.name || item.id);
}

function normalizeOrderPayload(order: Record<string, any> = {}) {
  const items = normalizeOrderItems(order.items);
  const id = String(order.id || order.order_id || order.uuid || "").trim();
  const displayNumber = String(
    order.display_number || order.order_number || order.number || order.order_no || order.public_number || order.display_id || id,
  ).trim();
  return {
    id,
    order_id: id,
    display_number: displayNumber,
    order_number: displayNumber,
    phone: normalizePhone(order.phone || order.phone_e164 || order.customer_phone || ""),
    status: String(order.status || order.order_status || order.workflow_status || order.state || "").trim(),
    total_price: Number(order.total_price || order.total || 0) || 0,
    address: String(order.address || "").trim().slice(0, 240),
    comment: String(order.comment || "").trim().slice(0, 500),
    is_pickup: toBool(order.is_pickup, false),
    payment_status: String(order.payment_status || "").trim().slice(0, 80),
    ai_comment: String(order.ai_comment || "").trim().slice(0, 1000),
    created_at: String(order.created_at || order.date || order.date_added || order.time || "").trim().slice(0, 80),
    items,
  };
}

function orderMatchesReference(order: Record<string, any>, reference: string) {
  return [order.id, order.order_id, order.display_number, order.order_number, order.number]
    .some((value) => String(value || "").trim() === reference);
}

export function normalizeOrderContextPayload(
  data: Record<string, any> = {},
  options: { phone?: string; orderId?: string | number } = {},
) {
  const source = safeJsonObject(data.context || data.order_context, data);
  const requestedPhone = normalizePhone(options.phone || "");
  const requestedOrder = String(options.orderId || "").trim();
  const direct = [source.order, source.active_order, data.order, data.active_order]
    .filter((value) => value && typeof value === "object")
    .map((value) => normalizeOrderPayload(value));
  const activeOrders = [source.active_orders, data.active_orders]
    .filter(Array.isArray)
    .flat()
    .map((value) => normalizeOrderPayload(value))
    .filter((order) => order.id && !isInactiveOrderStatus(order.status))
    .filter((order, index, list) => list.findIndex((candidate) => candidate.id === order.id) === index);
  const recentOrders = [source.recent_orders, source.orders, data.recent_orders, data.orders]
    .filter(Array.isArray)
    .flat()
    .map((value) => normalizeOrderPayload(value))
    .filter((order) => order.id)
    .filter((order, index, list) => list.findIndex((candidate) => candidate.id === order.id) === index);
  const allOrders = [...direct, ...activeOrders, ...recentOrders].filter((order, index, list) =>
    order.id && list.findIndex((candidate) => candidate.id === order.id) === index
  );
  const ownedOrders = requestedPhone
    ? allOrders.filter((order) => !order.phone || order.phone === requestedPhone)
    : allOrders;
  const selected = requestedOrder
    ? ownedOrders.find((order) => orderMatchesReference(order, requestedOrder)) || null
    : ownedOrders.find((order) => !isInactiveOrderStatus(order.status)) || null;
  const activeOrder = selected && !isInactiveOrderStatus(selected.status) ? selected : null;
  const hasActiveOrder = Boolean(activeOrder?.id);
  return {
    source: source.source || data.source || "alemi_order_context",
    order_id: selected?.id || String(source.order_id || data.order_id || "0"),
    display_number: selected?.display_number || "",
    status: selected?.status || source.status || data.status || null,
    order: selected,
    active_order: hasActiveOrder ? activeOrder : null,
    active_orders: activeOrders.filter((order) => !requestedPhone || !order.phone || order.phone === requestedPhone),
    recent_orders: recentOrders,
  };
}

const inactiveStatuses = new Set(["completed", "done", "finished", "closed", "cancelled", "canceled", "refunded"]);

function isInactiveOrderStatus(status = "") {
  return inactiveStatuses.has(String(status || "").trim().toLowerCase().replace(/\s+/g, "_"));
}

export async function getOrderStatus(instanceId: string, phone: string, domain: string) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return null;
  const key = `last_order:${instanceId}:${cleanPhone}`;

  try {
    const data = await apiBot(
      domain,
      { action: "check_status", phone: cleanPhone, restaurant_id: instanceId },
      10000
    );

    const context = normalizeOrderContextPayload(data || {}, { phone: cleanPhone });
    if (context.active_order) {
      const order = context.active_order;
      if (!order.id || isInactiveOrderStatus(order.status)) {
        await deleteCache(key);
        return null;
      }
      const result = {
        order_id: order.id,
        status: order.status || data.status || "status_unknown",
        order,
        active_order: order,
        active_orders: context.active_orders,
        recent_orders: context.recent_orders,
        items: order.items,
        total_price: order.total_price,
        address: order.address,
        comment: order.comment,
        is_pickup: order.is_pickup,
        payment_status: order.payment_status,
      };
      await setJsonCache(key, 86400, result);
      return result;
    }

    await deleteCache(key);
    return null;
  } catch (error: any) {
    auditError("DLE order status read failed", error, { instanceId, phone: cleanPhone });
    const backup = await getJsonCache<Record<string, any>>(key);
    return backup ? { ...backup, is_stale: true, status: backup.status || "last_known_order_offline" } : null;
  }
}

export async function getOrderContext(
  instanceId: string,
  domain: string,
  options: { phone?: string; orderId?: string | number } = {}
) {
  const cleanPhone = normalizePhone(options.phone || "");
  const orderId = String(options.orderId || "").trim();
  // Hub resolves orders by phone only. An order-number-only lookup used to be
  // sent anyway and came back 400, which the catch below reported as an outage;
  // without a phone there is genuinely nothing to read, so say so cheaply.
  if (!cleanPhone) return null;

  const key = orderId
    ? `order_context:${instanceId}:id:${orderId}`
    : `order_context:${instanceId}:phone:${cleanPhone}`;

  try {
    const data = await apiBot(
      domain,
      {
        action: "get_order_context",
        phone: cleanPhone,
        order_id: orderId,
        restaurant_id: instanceId,
      },
      10000
    );
    const context = normalizeOrderContextPayload(data || {}, { phone: cleanPhone, orderId });
    const activeOrder = context.active_order;
    if (!activeOrder || isInactiveOrderStatus(activeOrder.status)) {
      await deleteCache(key);
      const exactOrder = context.order && orderId ? context.order : null;
      return {
        ...context,
        found: Boolean(exactOrder),
        active: false,
        active_order: null,
        order: exactOrder,
        items: exactOrder?.items || [],
        total_price: exactOrder?.total_price || 0,
        address: exactOrder?.address || "",
        comment: exactOrder?.comment || "",
        is_pickup: exactOrder?.is_pickup || false,
        payment_status: exactOrder?.payment_status || "",
      };
    }
    const result = {
      ...context,
      active: true,
      items: activeOrder.items,
      total_price: activeOrder.total_price,
      address: activeOrder.address,
      comment: activeOrder.comment,
      is_pickup: activeOrder.is_pickup,
      payment_status: activeOrder.payment_status,
    };
    await setJsonCache(key, 86400, result);
    return result;
  } catch (error: any) {
    auditError("DLE order context read failed", error, { instanceId, phone: cleanPhone, orderId });
    const backup = await getJsonCache<Record<string, any>>(key);
    if (backup) return { ...backup, is_stale: true, status: backup.status || "last_known_order_offline" };
    // Returning null here made an unreachable hub indistinguishable from "this
    // guest has no order", and the guest was told their order does not exist -
    // including a guest who had just paid. `is_stale` routes to the honest
    // "temporarily unavailable" answer instead.
    return { is_stale: true, lookup_unavailable: true, status: "order_lookup_unavailable" };
  }
}

// hub.alemi.kz answers catalog.context.get with its own field names, and reading
// only the legacy ones silently zeroed the whole menu: every dish reached the
// model with id 0 and price 0, because hub sends a UUID id and the price under
// price_amount_minor. A guest asking the price was then answered from a fact
// that said zero.
//
// On the money: hub labels the field "minor" but stores whole tenge. Verified
// 2026-08-11 against the live storefront — Неаполитанская reads
// price_amount_minor: 3000 in the API and "3 000 тг" on the page. So the value
// is used as-is; dividing by 100 would under-price the menu 100-fold.
//
// The id stays a string: a UUID is not a number, and Number() on it is 0.
function firstNumber(...values: unknown[]) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export function normalizeMenuItem(item: Record<string, any> = {}) {
  const price = firstNumber(item.price, item.price_amount_minor, item.price_amount, item.amount);
  const compareAt = firstNumber(item.compare_at_price_amount_minor, item.compare_at_price, item.old_price);
  const tags = Array.isArray(item.tags) ? item.tags.map((tag: unknown) => String(tag || "").trim()).filter(Boolean) : [];
  return {
    id: String(item.id ?? "").trim(),
    category_id: String(item.category_id ?? "").trim(),
    category_name: String(item.category_name || item.category || "").trim(),
    name: String(item.name || item.title || "").trim(),
    description: String(item.description || "").trim(),
    composition: String(item.composition || "").trim(),
    price,
    // compare_at is hub's crossed-out "was" price, so the discount is on price
    // itself. Reporting it as promo_price would invert the two and quote the
    // higher number as the offer.
    compare_at_price: compareAt > price ? compareAt : 0,
    promo_price: firstNumber(item.promo_price),
    bonus: firstNumber(item.bonus_earn_amount_minor, item.bonus),
    // Availability was dropped here, so searchMenu's `typeof available ===
    // "boolean"` check could never be true and a sold-out dish looked orderable.
    available: typeof item.available === "boolean" ? item.available : true,
    tags,
    label: String(item.label || tags[0] || "").trim(),
  };
}

export async function getMenuContext(instanceId: string, domain: string, userLang: "kk" | "ru" = "kk") {
  const lang = userLang === "ru" ? "ru" : "kz";
  // v2 because the v1 payloads cached under the old key hold the zeroed prices
  // this mapping fixes, and the backup copy lives for 24h: reusing that key
  // would keep serving price 0 for a day after the fix ships.
  const cacheKey = `menu_context:v2:${instanceId}:${lang}`;
  const backupKey = `menu_context_backup:v2:${instanceId}:${lang}`;
  const cached = await getJsonCache<Record<string, any>>(cacheKey);
  if (cached) return cached;

  try {
    const data = await apiBot(domain, { action: "get_menu_context", restaurant_id: instanceId, lang }, 10000);
    const rawItems = Array.isArray(data?.items) ? data.items : [];
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    const menu = {
      source: "dle_spa_items",
      lang,
      count: Number(data?.count || rawItems.length) || rawItems.length,
      fetched_at: new Date().toISOString(),
      categories,
      items: rawItems.map(normalizeMenuItem).filter((item: ReturnType<typeof normalizeMenuItem>) => item.name),
    };
    await setJsonCache(cacheKey, 300, menu);
    await setJsonCache(backupKey, 86400, menu);
    return menu;
  } catch (error: any) {
    auditError("DLE menu context read failed", error, { instanceId, domain, lang });
    return (await getJsonCache<Record<string, any>>(backupKey)) || { items: [], source: "menu_unavailable" };
  }
}

function normalizeReceiptSenderName(value = "") {
  const text = String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const normalized = text.toLowerCase();
  const nameParts = text.match(/\p{L}[\p{L}.'’\-]*/gu) || [];
  if (
    !text ||
    /[^\p{L}\s.'’\-]/u.test(text) ||
    nameParts.length < 2 ||
    /^(payment\s*link|pay\s*link|qr|kaspi|halyk|unknown|sender|жіберуші|жіберуші аты|белгісіз|отправитель)$/iu.test(
      normalized
    )
  ) {
    return "Белгісіз";
  }
  return text;
}

function normalizeReceiptBankName(value = "") {
  const bank = String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (!bank || /(белгісіз|неизвест|unknown|анықталма|not[\s_-]*found)/iu.test(bank) || !/[\p{L}]{3,}/u.test(bank)) {
    return "";
  }
  return bank;
}

function normalizeReceiptText(value = "", fallback = "") {
  const raw = firstValue(value, fallback);
  return raw ? raw.slice(0, 480) : "";
}

export function buildReceiptCrmPayload(data: Record<string, any>) {
  const sender = normalizeReceiptSenderName(data.sender_name);
  const bank = normalizeReceiptBankName(data.bank_name);
  if (sender === "Белгісіз" || !bank) throw new Error("RECEIPT_OCR_IDENTITY_REQUIRED");
  const amountPaid = Number(data.amount || data.amount_paid || 0);
  const transactionId = String(data.transaction_id || data.receipt_transaction_id || "").trim().slice(0, 120);
  const paidAt = String(data.paid_at || data.date_time || data.payment_date || "").trim().slice(0, 80);
  const fallbackReceiptParts = [
    amountPaid > 0 ? `amount=${amountPaid}` : "",
    sender ? `sender=${sender}` : "",
    bank ? `bank=${bank}` : "",
    transactionId ? `transaction=${transactionId}` : "",
    paidAt ? `paid_at=${paidAt}` : "",
  ].filter(Boolean);
  const fallbackReceiptText = fallbackReceiptParts.length ? `payment_receipt ${fallbackReceiptParts.join("; ")}` : "";
  const receiptText = normalizeReceiptText(data.receipt_text, fallbackReceiptText);
  return {
    action: "add_payment_comment",
    order_id: String(data.order_id || "0").trim(),
    amount_paid: amountPaid,
    sender_name: `${sender} (${bank})`,
    bank_name: bank,
    receipt_text: receiptText,
  };
}

export async function sendOperatorSosSignal(input: {
  instanceId: string;
  phone: string;
  domain: string;
  signalId: string;
  caseId?: string;
  kind: string;
  summary: string;
  urgency?: string;
  source?: string;
}) {
  void input;
  throw new Error("ALEMI_OPERATOR_SOS_REDIS_ONLY");
}

// updateCrmLead hands over its whole tenant config so the hub call can sign
// without a second platform read - and it was being dropped on the way to the
// hub while `...data` carried it straight into Redis. saveDailyLog
// JSON-stringifies what it is given into `daily_logs:<instance>`, so
// alemi_secret and every other tenant credential was written there, to be read
// back by crm.today.get and the analytics cron. The config now goes to the
// signer and nowhere near the log.
export function crmDailyLogEntry(actionType: string, phone: string, data: Record<string, any>) {
  const { config, ...loggable } = data;
  void config;
  return { action: actionType, phone, ...loggable };
}

export async function updateCrmAction(
  actionType: "update_crm" | "receipt",
  instanceId: string,
  phone: string,
  data: Record<string, any>
) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) return null;
  if (actionType === "receipt") throw new Error("ALEMI_RECEIPT_BYTES_REQUIRED");

  // updateCrmLead hands over its whole tenant config so the hub call can sign
  // without a second platform read; crmDailyLogEntry() keeps it out of Redis.
  const tenantConfig = data.config as Record<string, any> | undefined;

  const payload: Record<string, any> = {
    phone: cleanPhone,
    restaurant_id: instanceId,
  };

  if (actionType === "update_crm") {
    Object.assign(payload, {
      action: "update_crm",
      interest: data.interest || "белгісіз",
      sales_stage: data.sales_stage || "жаңа",
      psycho_analysis: data.psycho_analysis || "мәлімет жоқ",
    });
  } else {
    Object.assign(payload, buildReceiptCrmPayload(data));
  }

  try {
    const response = await apiBot("", payload, 10000, { config: tenantConfig });
    await saveDailyLog(instanceId, crmDailyLogEntry(actionType, cleanPhone, data)).catch((error: any) => {
      auditError("CRM daily log save failed", error, { instanceId, actionType, phone: cleanPhone });
    });
    return response;
  } catch (error: any) {
    auditError("CRM update failed", error, { actionType, instanceId, phone: cleanPhone });
    return null;
  }
}

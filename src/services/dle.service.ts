import http from "node:http";
import https from "node:https";
import axios from "axios";
import { deleteCache, getJsonCache, setJsonCache } from "./redis.service.js";

const safeHttpAgent = new http.Agent({ keepAlive: false });
const safeHttpsAgent = new https.Agent({ keepAlive: false });

export function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function normalizePublicDomain(rawDomain = "") {
  const trimmed = String(rawDomain || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withProtocol);
  return `${url.protocol}//${url.host}`;
}

async function apiBot(domain: string, payload: Record<string, any>, timeout = 10000) {
  const safeDomain = normalizePublicDomain(domain);
  if (!safeDomain) throw new Error("DLE domain is empty");
  const response = await axios.post(
    `${safeDomain}/api_bot.php`,
    {
      token: process.env.CRM_SECRET_TOKEN,
      ...payload,
    },
    {
      timeout,
      maxRedirects: 0,
      httpAgent: safeHttpAgent,
      httpsAgent: safeHttpsAgent,
    }
  );
  if (response.data?.success === false) {
    throw new Error(response.data?.error || "api_bot returned success=false");
  }
  return response.data;
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

export function normalizeRuntimeStatus(data: Record<string, any> = {}) {
  const nested =
    safeJsonObject(data.runtime_status, null) ||
    safeJsonObject(data.kitchen_status, null) ||
    safeJsonObject(data.status, null) ||
    data;
  const kitchen = safeJsonObject(nested.kitchen_status || nested.settings || nested, {});
  const waitTime = Number(kitchen.wait_time ?? nested.wait_time ?? data.wait_time ?? 0) || 0;
  const resetAt = Number(kitchen.reset_at ?? nested.reset_at ?? data.reset_at ?? 0) || 0;

  return {
    is_accepting_orders: toBool(nested.is_accepting_orders ?? data.is_accepting_orders, true),
    within_work_hours: toBool(nested.within_work_hours ?? data.within_work_hours, true),
    closed_reason: String(nested.closed_reason || data.closed_reason || "").trim(),
    delivery: toBool(kitchen.delivery ?? nested.delivery ?? data.delivery, true),
    pickup: toBool(kitchen.pickup ?? nested.pickup ?? data.pickup, true),
    wait_time: waitTime,
    reset_at: resetAt,
    is_emergency: toBool(kitchen.is_emergency ?? nested.is_emergency ?? data.is_emergency, false),
    kitchen_status: {
      wait_time: waitTime,
      reset_at: resetAt,
      delivery: toBool(kitchen.delivery ?? nested.delivery ?? data.delivery, true),
      pickup: toBool(kitchen.pickup ?? nested.pickup ?? data.pickup, true),
      is_emergency: toBool(kitchen.is_emergency ?? nested.is_emergency ?? data.is_emergency, false),
    },
    payment_details: normalizePaymentDetails(data.payment_details || nested.payment_details || kitchen.payment_details),
    source: data.source || "dle_spa_settings",
    fetched_at: new Date().toISOString(),
  };
}

export async function getRuntimeStatus(
  instanceId: string,
  domain: string,
  options: { forceFresh?: boolean } = {}
): Promise<Record<string, any> | null> {
  if (!domain) return null;
  const cacheKey = `runtime_status:${instanceId}`;
  const backupKey = `runtime_status_backup:${instanceId}`;

  if (!options.forceFresh) {
    const cached = await getJsonCache<Record<string, any>>(cacheKey);
    if (cached) return cached;
  }

  try {
    const data = await apiBot(domain, { action: "get_runtime_status", restaurant_id: instanceId }, 8000);
    const status = normalizeRuntimeStatus(data || {});
    await setJsonCache(cacheKey, 5, status);
    await setJsonCache(backupKey, 600, status);
    return status;
  } catch (error: any) {
    console.error(`[RUNTIME] DLE read failed (${instanceId}):`, error?.message || error);
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
      name: String(item?.name || item?.title || item?.product_name || "").trim().slice(0, 120),
      qty: Number(item?.qty || item?.count || item?.quantity || 1) || 1,
      price: Number(item?.price || item?.amount || 0) || 0,
      total: Number(item?.total || item?.sum || 0) || 0,
      comment: String(item?.comment || item?.note || "").trim().slice(0, 240),
    }))
    .filter((item) => item.name || item.id);
}

function normalizeOrderPayload(order: Record<string, any> = {}) {
  const items = normalizeOrderItems(order.items);
  return {
    id: String(order.id || order.order_id || "").trim(),
    phone: normalizePhone(order.phone || ""),
    status: String(order.status || "").trim(),
    total_price: Number(order.total_price || order.total || 0) || 0,
    address: String(order.address || "").trim().slice(0, 240),
    comment: String(order.comment || "").trim().slice(0, 500),
    is_pickup: toBool(order.is_pickup, false),
    payment_status: String(order.payment_status || "").trim().slice(0, 80),
    created_at: String(order.created_at || order.date || order.date_added || order.time || "").trim().slice(0, 80),
    items,
  };
}

const inactiveStatuses = new Set(["completed", "done", "finished", "closed", "cancelled", "canceled", "refunded"]);

function isInactiveOrderStatus(status = "") {
  return inactiveStatuses.has(String(status || "").trim().toLowerCase().replace(/\s+/g, "_"));
}

export async function getOrderStatus(instanceId: string, phone: string, domain: string) {
  const cleanPhone = normalizePhone(phone);
  if (!domain || !cleanPhone) return null;
  const key = `last_order:${instanceId}:${cleanPhone}`;

  try {
    const data = await apiBot(
      domain,
      { action: "check_status", phone: cleanPhone, restaurant_id: instanceId },
      10000
    );

    if (data?.success && data?.order_id && String(data.order_id) !== "0") {
      const order = normalizeOrderPayload(data.order || data.active_order || { id: data.order_id, status: data.status });
      if (!order.id || isInactiveOrderStatus(order.status)) {
        await deleteCache(key);
        return null;
      }
      const result = {
        order_id: order.id,
        status: order.status || data.status || "status_unknown",
        order,
        active_order: order,
        recent_orders: Array.isArray(data.recent_orders) ? data.recent_orders.map(normalizeOrderPayload) : [],
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
    console.error(`[ORDER] DLE status read failed (${instanceId}/${cleanPhone}):`, error?.message || error);
    const backup = await getJsonCache<Record<string, any>>(key);
    return backup ? { ...backup, is_stale: true, status: backup.status || "last_known_order_offline" } : null;
  }
}

function normalizeMenuItem(item: Record<string, any> = {}) {
  return {
    id: Number(item.id) || 0,
    category_id: Number(item.category_id) || 0,
    category_name: String(item.category_name || item.category || "").trim(),
    name: String(item.name || item.title || "").trim(),
    description: String(item.description || "").trim(),
    composition: String(item.composition || "").trim(),
    price: Number(item.price) || 0,
    promo_price: Number(item.promo_price) || 0,
    label: String(item.label || "").trim(),
  };
}

export async function getMenuContext(instanceId: string, domain: string, userLang: "kk" | "ru" = "kk") {
  if (!domain) return { items: [], source: "empty_domain" };
  const lang = userLang === "ru" ? "ru" : "kz";
  const cacheKey = `menu_context:${instanceId}:${lang}`;
  const backupKey = `menu_context_backup:${instanceId}:${lang}`;
  const cached = await getJsonCache<Record<string, any>>(cacheKey);
  if (cached) return cached;

  try {
    const data = await apiBot(domain, { action: "get_menu_context", restaurant_id: instanceId, lang }, 10000);
    const rawItems = Array.isArray(data?.items) ? data.items : [];
    const menu = {
      source: "dle_spa_items",
      lang,
      fetched_at: new Date().toISOString(),
      items: rawItems.map(normalizeMenuItem).filter((item: ReturnType<typeof normalizeMenuItem>) => item.name),
    };
    await setJsonCache(cacheKey, 300, menu);
    await setJsonCache(backupKey, 86400, menu);
    return menu;
  } catch (error: any) {
    console.error(`[MENU] DLE menu read failed (${instanceId}):`, error?.message || error);
    return (await getJsonCache<Record<string, any>>(backupKey)) || { items: [], source: "menu_unavailable" };
  }
}

function normalizeReceiptSenderName(value = "") {
  const text = String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
  const normalized = text.toLowerCase();
  if (
    !text ||
    /^(payment\s*link|pay\s*link|qr|kaspi|halyk|unknown|sender|жіберуші|жіберуші аты|белгісіз|отправитель)$/iu.test(
      normalized
    )
  ) {
    return "Белгісіз";
  }
  return text;
}

export async function updateCrmAction(
  actionType: "update_crm" | "receipt",
  instanceId: string,
  phone: string,
  data: Record<string, any>
) {
  const domain = data?.config?.domain || "";
  const cleanPhone = normalizePhone(phone);
  if (!domain || !cleanPhone) return null;

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
    Object.assign(payload, {
      action: "add_payment_comment",
      order_id: String(data.order_id || "0").trim(),
      amount_paid: Number(data.amount || data.amount_paid || 0),
      sender_name: `${normalizeReceiptSenderName(data.sender || data.sender_name)} (${String(data.bank_name || "KASPI")
        .trim()
        .slice(0, 40)})`,
    });
  }

  try {
    return await apiBot(domain, payload, 10000);
  } catch (error: any) {
    console.error(`[CRM] update failed (${actionType}/${instanceId}/${cleanPhone}):`, error?.message || error);
    return null;
  }
}

import http from "node:http";
import https from "node:https";
import net from "node:net";
import * as dnsCallback from "node:dns";
import dns from "node:dns/promises";
import axios from "axios";
import { deleteCache, getJsonCache, saveDailyLog, setJsonCache } from "./redis.service.js";
const GROUP_OR_STATUS_RE = /(@g\.us$|^status@broadcast$)/i;
const PHONE_JID_RE = /@(c\.us|s\.whatsapp\.net)$/i;
const LID_JID_RE = /@lid$/i;
function normalizeIp(ip) {
    return String(ip || "").replace(/^::ffff:/i, "");
}
export function isPrivateIp(ipValue) {
    const ip = normalizeIp(ipValue).toLowerCase();
    if (!net.isIP(ip))
        return false;
    if (ip === "::1" || ip === "0:0:0:0:0:0:0:1")
        return true;
    if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80:"))
        return true;
    if (ip === "127.0.0.1" || ip === "0.0.0.0")
        return true;
    if (ip.startsWith("10."))
        return true;
    if (ip.startsWith("192.168."))
        return true;
    if (ip.startsWith("169.254."))
        return true;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip))
        return true;
    return false;
}
function safeLookup(hostname, options, callback) {
    dnsCallback.lookup(hostname, options, (error, address, family) => {
        if (error)
            return callback(error);
        if (isPrivateIp(address))
            return callback(new Error("PRIVATE_DNS_BLOCKED"));
        return callback(null, address, family);
    });
}
export const safeHttpAgent = new http.Agent({ keepAlive: false, lookup: safeLookup });
export const safeHttpsAgent = new https.Agent({ keepAlive: false, lookup: safeLookup });
export function normalizeKazakhstanPhone(digits) {
    if (!digits)
        return "";
    let phone = String(digits).replace(/\D/g, "");
    if (phone.startsWith("00"))
        phone = phone.slice(2);
    if (phone.length === 10)
        phone = `7${phone}`;
    if (phone.startsWith("8") && phone.length === 11)
        phone = `7${phone.slice(1)}`;
    return /^7\d{10}$/.test(phone) ? phone : "";
}
export function isGroupOrStatusJid(value) {
    const raw = String(value || "").trim().toLowerCase();
    return GROUP_OR_STATUS_RE.test(raw);
}
export function extractPhoneCandidate(rawValue) {
    const raw = String(rawValue || "").trim();
    if (!raw || isGroupOrStatusJid(raw))
        return "";
    if (LID_JID_RE.test(raw))
        return "";
    const phoneLikeMatch = raw.match(/(?:\+?7|8)[\s().-]*\d{3}[\s().-]*\d{3}[\s().-]*\d{2}[\s().-]*\d{2}/) ||
        raw.match(/\d{10,15}/);
    return phoneLikeMatch ? phoneLikeMatch[0] : "";
}
export function normalizePhone(value = "") {
    return normalizeKazakhstanPhone(extractPhoneCandidate(value));
}
export function normalizePhoneFromCandidates(candidates = []) {
    for (const candidate of candidates) {
        const phone = normalizePhone(candidate);
        if (phone)
            return phone;
    }
    return "";
}
export function getPhoneCandidatesFromWebhook(data = {}, eventData = {}, key = {}) {
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
export function toWhatsAppChatId(value, jidLookup = null) {
    const raw = String(value || "").trim();
    if (!raw || isGroupOrStatusJid(raw))
        return "";
    const phone = normalizePhone(raw);
    if (phone && jidLookup && jidLookup.has(phone))
        return jidLookup.get(phone) || "";
    if (PHONE_JID_RE.test(raw) || LID_JID_RE.test(raw))
        return raw;
    if (phone)
        return `${phone}@c.us`;
    return "";
}
export async function normalizePublicDomain(rawDomain = "") {
    const input = String(rawDomain || "").trim();
    if (!input || input.length > 255)
        throw new Error("BAD_DOMAIN");
    const parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    if (!["http:", "https:"].includes(parsed.protocol))
        throw new Error("BAD_DOMAIN_PROTOCOL");
    if (parsed.username || parsed.password)
        throw new Error("BAD_DOMAIN_AUTH");
    const host = parsed.hostname.toLowerCase();
    if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
        throw new Error("LOCAL_DOMAIN_BLOCKED");
    }
    if (net.isIP(host) && isPrivateIp(host)) {
        throw new Error("PRIVATE_IP_BLOCKED");
    }
    const records = await Promise.race([
        dns.lookup(host, { all: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("DNS_TIMEOUT")), 5000)),
    ]);
    if (!records.length || records.some((record) => isPrivateIp(record.address))) {
        throw new Error("PRIVATE_DNS_BLOCKED");
    }
    return `${parsed.protocol}//${parsed.host}`;
}
async function apiBot(domain, payload, timeout = 10000) {
    const safeDomain = await normalizePublicDomain(domain);
    if (!safeDomain)
        throw new Error("DLE domain is empty");
    const token = process.env.CRM_SECRET_TOKEN;
    if (!token) {
        console.warn("[DLE] CRM_SECRET_TOKEN is not configured — api_bot requests will fail with 403");
    }
    const response = await axios.post(`${safeDomain}/api_bot.php`, {
        token,
        ...payload,
    }, {
        timeout,
        maxRedirects: 0,
        httpAgent: safeHttpAgent,
        httpsAgent: safeHttpsAgent,
    });
    if (response.data?.success === false) {
        throw new Error(response.data?.error || "api_bot returned success=false");
    }
    return response.data;
}
function toBool(value, fallback = false) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value !== 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized))
            return true;
        if (["0", "false", "no", "off"].includes(normalized))
            return false;
    }
    return fallback;
}
function safeJsonObject(value, fallback = {}) {
    if (value && typeof value === "object" && !Array.isArray(value))
        return value;
    if (typeof value !== "string" || !value.trim())
        return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
function normalizePaymentDetails(value) {
    const raw = Array.isArray(value) ? value : [];
    return raw
        .map((item) => ({
        label: String(item?.label || item?.name || "").trim().slice(0, 80),
        value: String(item?.value || item?.number || item?.link || "").trim().slice(0, 240),
        source: item?.source ? String(item.source) : undefined,
    }))
        .filter((item) => item.label && item.value);
}
export function normalizeRuntimeStatus(data = {}) {
    const settings = safeJsonObject(data.settings, {});
    const rawKitchenSettings = safeJsonObject(settings.kitchen_status, null);
    const fetchedWaitTime = Number(rawKitchenSettings?.wait_time || 0) || 0;
    const fetchedEmergency = rawKitchenSettings ? toBool(rawKitchenSettings.is_emergency, false) : false;
    const nested = safeJsonObject(data.runtime_status, null) ||
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
        fetched_settings: {
            wait_time: fetchedWaitTime,
            is_emergency: fetchedEmergency,
            source: rawKitchenSettings ? "settings.kitchen_status" : "missing_settings.kitchen_status",
        },
        payment_details: normalizePaymentDetails(data.payment_details || nested.payment_details || kitchen.payment_details),
        source: data.source || "dle_spa_settings",
        fetched_at: new Date().toISOString(),
    };
}
export async function getRuntimeStatus(instanceId, domain, options = {}) {
    if (!domain)
        return null;
    const cacheKey = `runtime_status:${instanceId}`;
    const backupKey = `runtime_status_backup:${instanceId}`;
    if (!options.forceFresh) {
        const cached = await getJsonCache(cacheKey);
        if (cached)
            return cached;
    }
    try {
        const data = await apiBot(domain, { action: "get_runtime_status", restaurant_id: instanceId }, 8000);
        const status = normalizeRuntimeStatus(data || {});
        await setJsonCache(cacheKey, 5, status);
        await setJsonCache(backupKey, 600, status);
        return status;
    }
    catch (error) {
        console.error(`[RUNTIME] DLE read failed (${instanceId}):`, error?.message || error);
        const backup = await getJsonCache(backupKey);
        if (!backup)
            return null;
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
function normalizeOrderItems(items) {
    let raw = items;
    if (typeof items === "string") {
        try {
            raw = JSON.parse(items);
        }
        catch {
            raw = [];
        }
    }
    if (!Array.isArray(raw))
        return [];
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
function normalizeOrderPayload(order = {}) {
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
export async function getOrderStatus(instanceId, phone, domain) {
    const cleanPhone = normalizePhone(phone);
    if (!domain || !cleanPhone)
        return null;
    const key = `last_order:${instanceId}:${cleanPhone}`;
    try {
        const data = await apiBot(domain, { action: "check_status", phone: cleanPhone, restaurant_id: instanceId }, 10000);
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
    }
    catch (error) {
        console.error(`[ORDER] DLE status read failed (${instanceId}/${cleanPhone}):`, error?.message || error);
        const backup = await getJsonCache(key);
        return backup ? { ...backup, is_stale: true, status: backup.status || "last_known_order_offline" } : null;
    }
}
function normalizeMenuItem(item = {}) {
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
export async function getMenuContext(instanceId, domain, userLang = "kk") {
    if (!domain)
        return { items: [], source: "empty_domain" };
    const lang = userLang === "ru" ? "ru" : "kz";
    const cacheKey = `menu_context:${instanceId}:${lang}`;
    const backupKey = `menu_context_backup:${instanceId}:${lang}`;
    const cached = await getJsonCache(cacheKey);
    if (cached)
        return cached;
    try {
        const data = await apiBot(domain, { action: "get_menu_context", restaurant_id: instanceId, lang }, 10000);
        const rawItems = Array.isArray(data?.items) ? data.items : [];
        const menu = {
            source: "dle_spa_items",
            lang,
            fetched_at: new Date().toISOString(),
            items: rawItems.map(normalizeMenuItem).filter((item) => item.name),
        };
        await setJsonCache(cacheKey, 300, menu);
        await setJsonCache(backupKey, 86400, menu);
        return menu;
    }
    catch (error) {
        console.error(`[MENU] DLE menu read failed (${instanceId}):`, error?.message || error);
        return (await getJsonCache(backupKey)) || { items: [], source: "menu_unavailable" };
    }
}
function normalizeReceiptSenderName(value = "") {
    const text = String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
    const normalized = text.toLowerCase();
    if (!text ||
        /^(payment\s*link|pay\s*link|qr|kaspi|halyk|unknown|sender|жіберуші|жіберуші аты|белгісіз|отправитель)$/iu.test(normalized)) {
        return "Белгісіз";
    }
    return text;
}
export async function updateCrmAction(actionType, instanceId, phone, data) {
    const domain = data?.config?.domain || "";
    const cleanPhone = normalizePhone(phone);
    if (!domain || !cleanPhone)
        return null;
    const payload = {
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
    }
    else {
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
        const response = await apiBot(domain, payload, 10000);
        await saveDailyLog(instanceId, {
            action: actionType,
            phone: cleanPhone,
            ...data,
        }).catch((error) => {
            console.error("[CRM] Daily log save error:", error?.message || error);
        });
        return response;
    }
    catch (error) {
        console.error(`[CRM] update failed (${actionType}/${instanceId}/${cleanPhone}):`, error?.message || error);
        return null;
    }
}

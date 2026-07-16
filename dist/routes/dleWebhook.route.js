import { Router as createRouter } from "express";
import { handleKanbanWebhook } from "../controllers/kanban.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
const DLE_WEBHOOK_PATHS = [
    "/dle-webhook",
    "/website-webhook",
    "/api/dle-webhook",
    "/api/website-webhook",
    "/api/kanban-webhook",
    "/webhook/dle",
    "/webhook/kanban",
    "/webhook/website",
];
function envBool(name, fallback = false) {
    const value = String(process.env[name] ?? "").trim().toLowerCase();
    if (!value)
        return fallback;
    return ["1", "true", "yes", "on"].includes(value);
}
function getRequestInstanceId(req) {
    return String(req.body?.instance ||
        req.body?.instanceId ||
        req.body?.restaurant_id ||
        req.body?.restaurant_instance ||
        req.body?.restaurantInstance ||
        req.query?.instance ||
        req.query?.instanceId ||
        req.query?.restaurant_id ||
        req.query?.restaurant_instance ||
        "").trim();
}
function getBearerToken(req) {
    return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}
function firstValue(...values) {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim() !== "")
            return value;
    }
    return "";
}
function normalizeAction(value) {
    const action = String(value || "").trim();
    const aliases = {
        create_order: "new_order",
        order_created: "new_order",
        update_status: "status_changed",
        change_status: "status_changed",
        payment_request: "request_payment",
        reject_order: "order_rejected",
        rejected_order: "order_rejected",
        create_shift_note: "shift_note_created",
        delete_shift_note: "shift_note_deleted",
    };
    return aliases[action] || action;
}
export function normalizeDlePayload(req) {
    const source = (req.body || {});
    const action = normalizeAction(firstValue(source.action, source.ajax_action, req.query.action));
    const order = source.order && typeof source.order === "object" ? source.order : {};
    const note = source.note && typeof source.note === "object" ? source.note : {};
    const normalized = {
        ...source,
        action,
        instance: firstValue(source.instance, source.instanceId, source.restaurant_id, source.restaurant_instance, source.restaurantInstance, req.query.instance, req.query.restaurant_id),
        phone: firstValue(source.phone, source.client_phone, source.customer_phone, source.customerPhone, source.senderPhone, order.phone, req.query.phone),
        order_id: firstValue(source.order_id, source.orderId, source.id, order.order_id, order.id, req.query.order_id),
        new_status: firstValue(source.new_status, source.status, source.order_status, source.orderStatus, order.status),
        total_price: firstValue(source.total_price, source.total, source.amount, source.sum, order.total_price, order.total),
        address: firstValue(source.address, order.address),
        comment: firstValue(source.comment, source.info, order.comment),
        items: firstValue(source.items, source.goods, source.products, order.items),
        lang: firstValue(source.lang, source.language, source.lang_code, source.locale),
        is_pickup: firstValue(source.is_pickup, source.pickup, source.delivery_type, source.deliveryType, order.is_pickup),
        reason: firstValue(source.reason, source.cancel_reason, source.reject_reason),
        note_id: firstValue(source.note_id, source.noteId, note.note_id, note.id),
        shift_key: firstValue(source.shift_key, source.shiftKey, note.shift_key),
        text: firstValue(source.text, source.note_text, source.note, source.message, note.text, note.note_text),
        expires_at: firstValue(source.expires_at, source.expiresAt, source.expires, source.until, note.expires_at),
        created_by: firstValue(source.created_by, source.createdBy, note.created_by),
        created_at: firstValue(source.created_at, source.createdAt, note.created_at),
        deleted_at: firstValue(source.deleted_at, source.deletedAt, note.deleted_at),
    };
    if (action === "status_changed" && !normalized.status)
        normalized.status = normalized.new_status;
    if (action === "new_order" && source.wait_time !== undefined)
        normalized.wait_time = source.wait_time;
    req.body = normalized;
}
async function verifyDleWebhook(req, res, next) {
    if (!envBool("DLE_WEBHOOK_AUTH_REQUIRED", false))
        return next();
    const expected = process.env.DLE_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN || process.env.OPENBOT_WEBHOOK_SECRET;
    const got = getBearerToken(req) || req.headers["x-api-key"] || req.body?.token || req.query?.token;
    if (expected && safeCompare(got, expected))
        return next();
    try {
        const instanceId = getRequestInstanceId(req);
        if (!instanceId)
            return res.status(401).json({ ok: false, error: "unauthorized" });
        const config = await getRestaurantConfig(instanceId);
        assertTenantSecret(req, config, "kanban");
        return next();
    }
    catch (error) {
        return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
    }
}
async function handleDleWebhook(req, res) {
    try {
        normalizeDlePayload(req);
        await handleKanbanWebhook(req, res);
    }
    catch (error) {
        const instanceId = getRequestInstanceId(req);
        await notifyDeveloperSystemFailure(instanceId, error, {
            scope: "dle-website-webhook",
            action: req.body?.action || "",
            orderId: req.body?.order_id || req.body?.orderId || req.body?.id || "",
        }).catch(() => undefined);
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: error?.message || "dle webhook failed" });
        }
    }
}
export function dleWebhookRoute() {
    const router = createRouter();
    for (const path of DLE_WEBHOOK_PATHS) {
        router.post(path, verifyDleWebhook, handleDleWebhook);
    }
    return router;
}

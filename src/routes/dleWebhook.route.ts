import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { handleKanbanWebhook } from "../controllers/kanban.js";
import { getRestaurantConfig, getRestaurantConfigByAlemiInstance, refreshRestaurantConfig } from "../services/platformConfig.service.js";
import { assertTenantSecret } from "../services/tenantAuth.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { auditError, auditInbound, auditProcessing, isNewDleAction } from "../services/auditLogger.service.js";
import { describeBodyShape } from "../utils/bodyShape.js";

export function isDleWebhookAuthRequired() {
  const configured = String(process.env.DLE_WEBHOOK_AUTH_REQUIRED ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(configured)) return true;
  if (["0", "false", "no", "off"].includes(configured)) return false;
  // Production must never silently expose the webhook when the flag is absent
  // or misspelled. Development and tests retain legacy opt-in behavior.
  return process.env.NODE_ENV === "production";
}

const INSTANCE_RE = /^[a-zA-Z0-9_-]{2,64}$/;

const ORDER_ACTIONS = new Set(["new_order", "status_changed", "request_payment", "order_rejected"]);

export function mapIncomingAlemiInstance(value: unknown, env: NodeJS.ProcessEnv = process.env) {
  const instance = String(value || "").trim();
  if (!instance) return "";
  try {
    const aliases = JSON.parse(String(env.ALEMI_INSTANCE_ALIASES_JSON || "{}"));
    const mapped = aliases && typeof aliases === "object" && !Array.isArray(aliases)
      ? String(aliases[instance] || "").trim()
      : "";
    return mapped && INSTANCE_RE.test(mapped) ? mapped : instance;
  } catch {
    return instance;
  }
}

function getRequestInstanceId(req: Request) {
  return String(req.body?.instance || req.query?.instance || "").trim();
}

function firstValue(...values: unknown[]) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

// Every audit site fed the RAW event name to isNewDleAction, so a hub event
// ("order.created", "shift_note.created", "kitchen.status_changed") was logged
// as matchesNewDleLogic=false while being handled perfectly - the flag read as
// "this signal is not recognised" in exactly the place someone debugging a lost
// signal looks first. Normalise the name the same way the handler does.
function recognisedDleAction(req: Request) {
  return isNewDleAction(normalizeAction(firstValue(
    req.body?.action,
    req.body?.ajax_action,
    req.body?.event_type,
    req.body?.eventType,
    req.body?.event,
    req.body?.type,
    req.query?.action,
  )));
}

function normalizeAction(value: unknown) {
  const action = String(value || "").trim().toLowerCase();
  const aliases: Record<string, string> = {
    "order.created": "new_order",
    "order.status_changed": "status_changed",
    "order.rejected": "order_rejected",
    "shift_note.created": "shift_note_created",
    "shift_note.deleted": "shift_note_deleted",
    "shift_note.expired": "shift_note_deleted",
    // The operator's «подтверждение» press is the successor of the legacy
    // request_payment step: the guest is told the food is available and how much
    // to pay. Without these three lines the confirm produced a 400 BAD_ACTION and
    // the guest heard nothing after "ожидайте 1-2 минуты".
    "order.confirmed": "request_payment",
    "order.accepted": "request_payment",
    "payment.requested": "request_payment",
    "payment.request": "request_payment",
    // Hub's current name for the operator's confirm press: the panel asks the
    // bot to collect payment from the guest. Without this alias every confirm
    // was a 400 BAD_ACTION and the guest was never asked to pay (2026-08-14).
    "order.external_document_requested": "request_payment",
    // Everything else hub can emit about an order is a status transition; routing
    // it here means an unknown status is answered 200-and-silent instead of a 400
    // that hub counts as a webhook error and retries for hours.
    "order.paid": "status_changed",
    "payment.received": "status_changed",
    "order.updated": "status_changed",
    "order.ready": "status_changed",
    "order.completed": "status_changed",
    "order.delivered": "status_changed",
    "order.cancelled": "order_rejected",
    "order.canceled": "order_rejected",
    "kitchen.status_changed": "update_kitchen_status",
    "kitchen.updated": "update_kitchen_status",
    "shift_note.updated": "shift_note_created",
    create_order: "new_order",
    order_created: "new_order",
    update_status: "status_changed",
    change_status: "status_changed",
    status_update: "status_changed",
    payment_request: "request_payment",
    request_pay: "request_payment",
    reject_order: "order_rejected",
    rejected_order: "order_rejected",
    cancel_order: "order_rejected",
    create_shift_note: "shift_note_created",
    delete_shift_note: "shift_note_deleted",
    shift_note_expired: "shift_note_deleted",
  };
  return aliases[action] || action;
}

// Hub emits the confirm both as its own event and as a status transition. Both
// must land on one internal action with one lock key, or a restaurant that sends
// both shapes would ask the guest to pay twice.
const CONFIRM_STATUSES = new Set(["confirmed", "accepted", "approved"]);

function objectRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function firstObject(...values: unknown[]): Record<string, any> {
  for (const value of values) {
    const record = objectRecord(value);
    if (Object.keys(record).length) return record;
  }
  return {};
}

function valueFrom(records: Record<string, any>[], ...keys: string[]) {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
  }
  return "";
}

function normalizeExternalId(value: unknown) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  const id = String(value ?? "").trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return id.toLowerCase();
  }
  return id;
}

export function isIgnoredAlemiEvent(value: unknown) {
  const v = String(value || "").trim();
  // order.external_document_received is hub's echo of our own receipt upload -
  // acknowledge it so hub stops retrying it for hours, but never notify the
  // guest about it.
  return /^external(?:[-_.]?document)(?:[-_.]|$)/i.test(v) || v === "order.external_document_received";
}

export function normalizeDlePayload(req: Request) {
  const source = (req.body || {}) as Record<string, any>;
  const payload = objectRecord(source.payload);
  const data = objectRecord(source.data);
  const payloadData = objectRecord(payload.data);
  const dataPayload = objectRecord(data.payload);
  const records = [source, payload, data, payloadData, dataPayload];
  // `event_type` is what hub sends today, but a webhook that names its event
  // `event` or `type` - the two other spellings every integration reaches for -
  // was answered 400 BAD_ACTION and the signal was thrown away. Accept all
  // three: normalizeAction() still decides what is a known action, so an
  // unrecognised name is rejected exactly as before.
  const rawEventType = valueFrom(records, "event_type", "eventType", "event", "type");
  const rawAction = firstValue(
    rawEventType,
    valueFrom(records, "action", "ajax_action"),
    req.query.action,
  );
  const action = normalizeAction(rawAction);
  const order = firstObject(...records.map((record) => record.order));
  // hub.alemi.kz serialises the guest inside the order, and names every money
  // field `*_amount_minor` while the value is whole tenge. The first real
  // order.created event was rejected with `invalid phone` because none of these
  // names existed in the lists below: the event was delivered and authenticated,
  // and then thrown away here. This block is the translation layer, so nothing
  // downstream has to learn two vocabularies.
  const customer = firstObject(
    ...records.map((record) => record.customer),
    ...records.map((record) => record.client),
    order.customer,
    order.client,
  );
  const note = firstObject(
    ...records.map((record) => record.note),
    ...records.map((record) => record.shift_note),
    ...records.map((record) => record.shiftNote),
  );
  // The operator confirm (order.external_document_requested) carries the money
  // inside a nested `amounts` object, not a flat field: without reading it the
  // guest would be asked to pay "0 ₸" (live event, 2026-08-14).
  const amounts = firstObject(
    ...records.map((record) => record.amounts),
    order.amounts,
  );
  const legacySourceId = rawEventType ? "" : source.id;
  const orderId = normalizeExternalId(firstValue(
    valueFrom(records, "order_id", "orderId"),
    legacySourceId,
    order.order_id,
    order.orderId,
    order.id,
    req.query.order_id,
  ));

  const normalized: Record<string, any> = {
    ...dataPayload,
    ...payloadData,
    ...data,
    ...payload,
    ...source,
    action,
    event_type: rawEventType,
    event_id: normalizeExternalId(firstValue(valueFrom(records, "event_id", "eventId"), rawEventType ? source.id : "", req.headers?.["x-event-id"])),
    request_id: normalizeExternalId(firstValue(valueFrom(records, "request_id", "requestId", "delivery_id", "deliveryId"), req.headers?.["x-request-id"])),
    instance: firstValue(valueFrom(records, "instance", "instance_id", "instanceId"), order.instance, note.instance, req.query.instance),
    phone: firstValue(
      valueFrom(records, "phone", "phone_e164", "phoneE164", "client_phone", "clientPhone", "customer_phone", "customerPhone", "recipient", "senderPhone"),
      valueFrom([order, customer], "phone", "phone_e164", "phoneE164", "client_phone", "clientPhone", "customer_phone", "customerPhone"),
      req.query.phone
    ),
    order_id: orderId,
    order_number: firstValue(valueFrom(records, "order_number", "orderNumber"), order.order_number, order.orderNumber),
    new_status: firstValue(valueFrom(records, "new_status", "status", "order_status", "orderStatus"), order.status),
    total_price: firstValue(
      valueFrom(records, "total_price", "total", "amount", "sum", "total_amount_minor", "totalAmountMinor", "total_amount"),
      valueFrom([order], "total_price", "total", "amount", "total_amount_minor", "totalAmountMinor", "total_amount"),
      valueFrom([amounts], "total", "total_amount_minor", "totalAmountMinor", "grand_total", "grandTotal", "total_with_delivery", "totalWithDelivery", "sum", "amount"),
    ),
    delivery_price: firstValue(
      valueFrom(records, "delivery_price", "delivery_amount_minor", "deliveryAmountMinor", "delivery_fee", "deliveryFee"),
      valueFrom([order], "delivery_price", "delivery_amount_minor", "deliveryAmountMinor", "delivery_fee"),
      valueFrom([amounts], "delivery", "delivery_fee", "deliveryFee", "delivery_amount_minor", "deliveryAmountMinor"),
    ),
    bonus: firstValue(valueFrom(records, "bonus", "bonus_spent_amount_minor", "bonusSpentAmountMinor"), order.bonus_spent_amount_minor),
    persons: firstValue(valueFrom(records, "persons", "cutlery_count", "cutleryCount"), order.cutlery_count),
    address: firstValue(valueFrom(records, "address"), order.address),
    comment: firstValue(valueFrom(records, "comment", "info"), order.comment),
    items: firstValue(valueFrom(records, "items", "goods", "products", "order_items", "orderItems"), order.items, order.goods, order.products, order.order_items),
    lang: valueFrom(records, "lang", "language", "lang_code", "locale"),
    is_pickup: firstValue(
      valueFrom(records, "is_pickup", "isPickup", "pickup", "delivery_type", "deliveryType", "fulfillment_type", "fulfillmentType"),
      valueFrom([order], "is_pickup", "isPickup", "delivery_type", "fulfillment_type", "fulfillmentType"),
    ),
    reason: firstValue(valueFrom(records, "reason", "cancel_reason", "reject_reason"), order.reason),
    note_id: normalizeExternalId(firstValue(valueFrom(records, "note_id", "noteId"), note.note_id, note.noteId, note.id)),
    shift_key: firstValue(valueFrom(records, "shift_key", "shiftKey"), note.shift_key, note.shiftKey),
    // The note payload may arrive as an OBJECT ({note:{id,text}}). Picking the
    // object itself stringified it to "[object Object]" and that garbage was
    // saved into AI memory - and could never be deleted by text afterwards.
    // Only a STRING note field is a valid text candidate.
    text: firstValue(
      valueFrom(records, "text", "note_text"),
      note.text,
      note.note_text,
      valueFrom(records, "message"),
      typeof source.note === "string" ? source.note : ""
    ),
    expires_at: firstValue(valueFrom(records, "expires_at", "expiresAt", "expires", "until"), note.expires_at, note.expiresAt),
    created_by: firstValue(valueFrom(records, "created_by", "createdBy"), note.created_by, note.createdBy),
    created_at: firstValue(valueFrom(records, "created_at", "createdAt"), note.created_at, note.createdAt),
    deleted_at: firstValue(valueFrom(records, "deleted_at", "deletedAt"), note.deleted_at, note.deletedAt),
  };

  if (action === "status_changed" && !normalized.status) normalized.status = normalized.new_status;
  // A confirm delivered as `order.status_changed` + status=confirmed is the same
  // operator press as `order.confirmed`. Collapsing it here (not in the controller)
  // keeps one action name, one lock key and one guest message for both shapes.
  if (normalized.action === "status_changed"
    && CONFIRM_STATUSES.has(String(normalized.new_status || normalized.status || "").trim().toLowerCase())) {
    normalized.action = "request_payment";
  }
  const waitTime = firstValue(
    valueFrom(records, "wait_time", "waitTime", "wait_time_minutes", "waitTimeMinutes"),
    valueFrom([order], "wait_time", "wait_time_minutes", "waitTimeMinutes"),
  );
  if (action === "new_order" && waitTime !== "") normalized.wait_time = waitTime;
  req.body = normalized;
}

/**
 * Re-exported from utils so existing importers (and tests) keep one entry point
 * while the controller can use it without a circular import.
 */
export { describeBodyShape } from "../utils/bodyShape.js";

type AlemiTenantLookup = (incomingInstance: string) => Promise<Record<string, any> | null>;

export async function resolveIncomingAlemiTenant(
  req: Request,
  res: Response,
  next: NextFunction,
  lookup: AlemiTenantLookup = getRestaurantConfigByAlemiInstance,
) {
  const incomingInstance = getRequestInstanceId(req);
  if (!incomingInstance) return next();
  try {
    const config = await lookup(incomingInstance);
    if (config) {
      const internalInstance = String(config.instance_id || config.instance || "").trim();
      if (!internalInstance) {
        return res.status(401).json({ ok: false, error: "TENANT_RESOLUTION_FAILED" });
      }
      req.body.instance = internalInstance;
      (req as any).resolvedRestaurantConfig = config;
      return next();
    }
    req.body.instance = mapIncomingAlemiInstance(incomingInstance);
    return next();
  } catch (error: any) {
    auditError("Alemi inbound tenant resolution failed", error, {
      incomingInstance,
      action: req.body?.action || req.body?.event_type || "",
    });
    const ambiguous = error?.message === "ALEMI_INSTANCE_AMBIGUOUS";
    return res.status(ambiguous ? 409 : 401).json({
      ok: false,
      error: ambiguous ? "ALEMI_INSTANCE_AMBIGUOUS" : "TENANT_RESOLUTION_FAILED",
    });
  }
}

type RestaurantConfigLoader = (instanceId: string) => Promise<Record<string, any> | null>;

export async function verifyTenantSecretWithRotationRefresh(
  req: Request,
  instanceId: string,
  options: {
    config?: Record<string, any> | null;
    loadConfig?: RestaurantConfigLoader;
    refreshConfig?: RestaurantConfigLoader;
  } = {},
): Promise<Record<string, any> | null> {
  const loadConfig = options.loadConfig || ((id: string) => getRestaurantConfig(id));
  const refreshConfig = options.refreshConfig || refreshRestaurantConfig;
  const config = options.config || await loadConfig(instanceId);
  try {
    assertTenantSecret(req, config, "kanban");
    return config;
  } catch (error: any) {
    // A rotated Alemi Secret Key must not lock the tenant out for the lifetime of
    // the cached config. One forced re-read, one re-check, then the original 403.
    // A missing secret (TENANT_SECRET_NOT_CONFIGURED) still denies immediately.
    if (error?.message !== "INVALID_TENANT_SECRET") throw error;
    const fresh = await refreshConfig(instanceId);
    if (!fresh) throw error;
    assertTenantSecret(req, fresh, "kanban");
    auditProcessing("DLE webhook tenant secret accepted after forced config refresh", { instanceId });
    return fresh;
  }
}

async function verifyDleWebhook(req: Request, res: Response, next: NextFunction) {
  if (!isDleWebhookAuthRequired()) {
    auditProcessing("DLE webhook auth bypassed", {
      action: req.body?.action || req.body?.ajax_action || req.query?.action || "",
      authRequired: false,
      matchesNewDleLogic: recognisedDleAction(req),
    });
    return next();
  }

  try {
    const instanceId = getRequestInstanceId(req);
    if (!instanceId) return res.status(401).json({ ok: false, error: "unauthorized" });
    const config = await verifyTenantSecretWithRotationRefresh(req, instanceId, {
      config: (req as any).resolvedRestaurantConfig,
    });
    if (config) (req as any).resolvedRestaurantConfig = config;
    auditProcessing("DLE webhook tenant secret accepted", {
      action: req.body?.action || req.body?.ajax_action || req.query?.action || "",
      instanceId,
      matchesNewDleLogic: recognisedDleAction(req),
    });
    return next();
  } catch (error: any) {
    auditError("DLE webhook auth failed", error, {
      action: req.body?.action || req.body?.ajax_action || req.query?.action || "",
      instanceId: getRequestInstanceId(req),
    });
    return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
  }
}

function requireStrictInstance(req: Request, res: Response, next: NextFunction) {
  const instance = getRequestInstanceId(req);
  if (!instance || !INSTANCE_RE.test(instance)) {
    res.status(400).json({ success: false, error: instance ? "BAD_INSTANCE" : "MISSING_INSTANCE" });
    return;
  }
  next();
}

export async function handleDleWebhook(req: Request, res: Response) {
  try {
    const action = req.body?.action || "";
    auditInbound("DLE/Alemi webhook received", {
      action,
      eventType: req.body?.event_type || "",
      eventId: req.body?.event_id || "",
      requestId: req.body?.request_id || "",
      matchesNewDleLogic: recognisedDleAction(req),
    });
    if (!req.body?.instance || !INSTANCE_RE.test(String(req.body.instance))) {
      const errorCode = req.body?.instance ? "BAD_INSTANCE" : "MISSING_INSTANCE";
      auditError("DLE webhook rejected: invalid strict body.instance", new Error(errorCode), {
        action,
        eventType: req.body?.event_type || "",
        eventId: req.body?.event_id || "",
      });
      res.status(400).json({ success: false, error: errorCode });
      return;
    }
    if (isIgnoredAlemiEvent(req.body?.event_type)) {
      auditProcessing("Alemi external-document event acknowledged without customer notification", {
        instance: req.body.instance,
        eventType: req.body.event_type,
        eventId: req.body.event_id || "",
        requestId: req.body.request_id || "",
      });
      res.status(200).json({ success: true, ignored: true, event_id: req.body.event_id || undefined });
      return;
    }
    auditInbound("DLE webhook normalized", {
      action: req.body?.action,
      matchesNewDleLogic: recognisedDleAction(req),
      instance: req.body?.instance,
      phone: req.body?.phone,
      order_id: req.body?.order_id,
      total_price: req.body?.total_price,
      new_status: req.body?.new_status,
      is_pickup: req.body?.is_pickup,
      wait_time: req.body?.wait_time,
      note_id: req.body?.note_id,
      shift_key: req.body?.shift_key,
      source: req.body?.source,
      event_time: req.body?.event_time,
      event_id: req.body?.event_id,
      request_id: req.body?.request_id,
    });
    if (!req.body?.phone && ORDER_ACTIONS.has(String(req.body?.action || ""))) {
      auditError("DLE webhook order event carries no recognisable phone field", new Error("PHONE_FIELD_UNMAPPED"), {
        action: req.body?.action || "",
        instance: req.body?.instance || "",
        eventId: req.body?.event_id || "",
        bodyShape: (req as any).inboundBodyShape || describeBodyShape(req.body),
      });
    }
    await handleKanbanWebhook(req, res);
  } catch (error: any) {
    const instanceId = getRequestInstanceId(req);
    auditError("DLE webhook processing failed", error, {
      action: req.body?.action || "",
      instanceId,
      orderId: req.body?.order_id || req.body?.orderId || req.body?.id || "",
    });
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

export function dleWebhookRoute(): Router {
  const router = createRouter();

  router.post("/", (req, _res, next) => {
    (req as any).inboundBodyShape = describeBodyShape(req.body);
    normalizeDlePayload(req);
    next();
  }, resolveIncomingAlemiTenant, requireStrictInstance, verifyDleWebhook, handleDleWebhook);

  return router;
}

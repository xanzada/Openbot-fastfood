// "Оплата при получении" support (hub PAYMENT_TIMING.md, 2026-10-04).
//
// Three things live here:
//  1. the per-order payment state, kept monotonic by payment_revision so that a
//     late or replayed event (rev 2 after rev 3, an old order.created) can never
//     roll the order back to an older payment choice;
//  2. the fresh `order.context.get {order_id, limit:1}` read the contract asks
//     for before any delayed payment message;
//  3. the pure decisions and guest texts, so the kanban controller and the
//     receipt lane share one source of truth and the rules are unit-testable.
import { callAlemiCommand, mapLegacyAlemiAction, type AlemiCallOptions } from "./alemiApi.service.js";
import { auditDecision, auditError } from "./auditLogger.service.js";
import { normalizeOrderContextPayload, normalizePhone } from "./dle.service.js";
import { connectRedis, redisClient, receiptSeenKey } from "./redis.service.js";
import {
  paymentFieldsFrom,
  type PaymentFields,
  type PaymentTiming,
} from "../utils/paymentTiming.js";

export { paymentFieldsFrom, normalizePaymentTiming, parsePaymentRevision, isOnReceipt } from "../utils/paymentTiming.js";
export type { PaymentFields, PaymentTiming } from "../utils/paymentTiming.js";

type Language = "kk" | "ru";

export interface StoredPaymentState {
  orderId: string;
  orderNumber: string;
  timing: PaymentTiming | null;
  revision: number;
  receiptRequired: boolean | null;
  total: number | null;
  phone: string;
  source: string;
  updatedAt: string;
}

export type PaymentRecordOutcome = "new" | "advanced" | "same" | "stale" | "skipped" | "unavailable";

export interface PaymentRecordResult {
  outcome: PaymentRecordOutcome;
  state: StoredPaymentState | null;
  previous: StoredPaymentState | null;
}

export const PAYMENT_STATE_TTL_SECONDS = 14 * 24 * 60 * 60;

export function paymentStateKey(instanceId: string, orderId: string) {
  return `payment_timing:${instanceId}:${orderId}`;
}

// Compare-and-set in one Redis step: two webhooks for one order can be in flight
// at the same time (hub does not guarantee order), so read-then-write in JS
// would let the older one win the race.
//  - lower revision than stored  -> stale, nothing written
//  - equal revision              -> only fills empty fields (authoritative fresh
//                                   reads may also correct the choice itself)
//  - higher revision             -> replaces the choice, keeps number/total/phone
const RECORD_PAYMENT_SCRIPT = `
local incoming = cjson.decode(ARGV[1])
local ttl = tonumber(ARGV[2])
local authoritative = ARGV[3] == '1'
local function empty(v) return v == nil or v == cjson.null or v == '' end
local raw = redis.call('GET', KEYS[1])
if not raw then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
  return {'new', ARGV[1], ''}
end
local ok, stored = pcall(cjson.decode, raw)
if not ok or type(stored) ~= 'table' then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ttl)
  return {'new', ARGV[1], ''}
end
local sr = tonumber(stored.revision) or 0
local ir = tonumber(incoming.revision) or 0
if ir < sr then return {'stale', raw, raw} end
if ir == sr then
  local changed = false
  for k, v in pairs(incoming) do
    if not empty(v) and (empty(stored[k]) or (authoritative and k ~= 'source' and k ~= 'updatedAt' and stored[k] ~= v)) then
      stored[k] = v
      changed = true
    end
  end
  if changed then
    local enc = cjson.encode(stored)
    redis.call('SET', KEYS[1], enc, 'EX', ttl)
    return {'same', enc, raw}
  end
  return {'same', raw, raw}
end
for _, k in ipairs({'orderNumber', 'total', 'phone'}) do
  if empty(incoming[k]) and not empty(stored[k]) then incoming[k] = stored[k] end
end
local enc = cjson.encode(incoming)
redis.call('SET', KEYS[1], enc, 'EX', ttl)
return {'advanced', enc, raw}
`;

function parseState(raw: unknown): StoredPaymentState | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(String(raw));
    if (!value || typeof value !== "object") return null;
    const fields = paymentFieldsFrom({
      payment_timing: value.timing,
      payment_revision: value.revision,
      receipt_required: value.receiptRequired,
    });
    const total = Number(value.total);
    return {
      orderId: String(value.orderId || ""),
      orderNumber: String(value.orderNumber || ""),
      timing: fields.timing,
      revision: fields.revision || 0,
      receiptRequired: fields.receiptRequired,
      total: Number.isFinite(total) && total > 0 ? total : null,
      phone: String(value.phone || ""),
      source: String(value.source || ""),
      updatedAt: String(value.updatedAt || ""),
    };
  } catch {
    return null;
  }
}

export function positiveAmount(value: unknown): number | null {
  const amount = Number(String(value ?? "").replace(/\s+/g, "").replace(",", "."));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export async function getPaymentState(instanceId: string, orderId: string): Promise<StoredPaymentState | null> {
  const cleanOrderId = String(orderId || "").trim();
  if (!instanceId || !cleanOrderId) return null;
  try {
    await connectRedis();
    return parseState(await redisClient.get(paymentStateKey(instanceId, cleanOrderId)));
  } catch {
    return null;
  }
}

export async function recordPaymentState(
  instanceId: string,
  orderId: string,
  fields: PaymentFields,
  meta: { source: string; orderNumber?: unknown; total?: unknown; phone?: unknown; authoritative?: boolean },
): Promise<PaymentRecordResult> {
  const cleanOrderId = String(orderId || "").trim();
  if (!instanceId || !cleanOrderId) return { outcome: "skipped", state: null, previous: null };
  if (!fields.revision) {
    // Legacy order (no payment fields): nothing to order by, nothing to store.
    const current = await getPaymentState(instanceId, cleanOrderId);
    return { outcome: "skipped", state: current, previous: current };
  }
  const incoming = {
    orderId: cleanOrderId,
    orderNumber: String(meta.orderNumber ?? "").trim().slice(0, 40),
    timing: fields.timing,
    revision: fields.revision,
    receiptRequired: fields.receiptRequired,
    total: positiveAmount(meta.total),
    phone: normalizePhone(String(meta.phone ?? "")),
    source: String(meta.source || "").slice(0, 60),
    updatedAt: new Date().toISOString(),
  };
  try {
    await connectRedis();
    const reply = (await redisClient.eval(RECORD_PAYMENT_SCRIPT, {
      keys: [paymentStateKey(instanceId, cleanOrderId)],
      arguments: [JSON.stringify(incoming), String(PAYMENT_STATE_TTL_SECONDS), meta.authoritative ? "1" : "0"],
    })) as unknown as string[];
    const outcome = (String(reply?.[0] || "unavailable") as PaymentRecordOutcome);
    const state = parseState(reply?.[1]);
    const previous = parseState(reply?.[2]);
    auditDecision("Payment timing state recorded", {
      instanceId,
      orderId: cleanOrderId,
      source: incoming.source,
      outcome,
      incomingRevision: incoming.revision,
      incomingTiming: incoming.timing,
      storedRevision: state?.revision ?? null,
      storedTiming: state?.timing ?? null,
    });
    return { outcome, state, previous };
  } catch (error) {
    auditError("Payment timing state write failed", error, { instanceId, orderId: cleanOrderId, source: incoming.source });
    return { outcome: "unavailable", state: parseState(JSON.stringify(incoming)), previous: null };
  }
}

// A switch of the payment choice starts a new cycle: the old "receipt already
// with the operator" marker must not turn the next request into a "Запросить
// снова" reply.
export async function clearReceiptSeenForOrder(instanceId: string, orderId: string) {
  if (!instanceId || !orderId) return false;
  try {
    await connectRedis();
    await redisClient.del(receiptSeenKey(instanceId, orderId));
    return true;
  } catch {
    return false;
  }
}

export interface FreshOrderPayment {
  orderId: string;
  orderNumber: string;
  phone: string;
  status: string;
  fields: PaymentFields;
  total: number | null;
  via: "order_id" | "phone";
}

function freshFromContext(data: unknown, orderId: string, via: FreshOrderPayment["via"]): FreshOrderPayment | null {
  const raw = (data && typeof data === "object" ? data : {}) as Record<string, any>;
  const context = normalizeOrderContextPayload(raw, { orderId });
  const order = context.order as Record<string, any> | null;
  if (!order || String(order.id || "").trim() !== orderId) return null;
  return {
    orderId,
    orderNumber: String(order.display_number || order.order_number || "").trim(),
    phone: normalizePhone(order.phone || ""),
    status: String(order.status || "").trim(),
    fields: paymentFieldsFrom(order),
    total: positiveAmount(order.total_price),
    via,
  };
}

function e164(phone: string) {
  const digits = normalizePhone(phone);
  return digits ? digits : "";
}

// The contract: before a delayed payment message read `order.context.get` with
// `{order_id, limit: 1}` and a NEW command_id (callAlemiCommand mints one per
// call). Hubs that predate the contract reject order_id (400); then the order is
// picked out of the guest's phone-scoped context when the phone is known.
export async function readFreshOrderPayment(
  instanceId: string,
  orderId: string,
  options: { config?: Record<string, any> | null; phone?: string; transport?: AlemiCallOptions["transport"]; timeoutMs?: number } = {},
): Promise<FreshOrderPayment | null> {
  const cleanOrderId = String(orderId || "").trim();
  if (!instanceId || !cleanOrderId) return null;
  const callOptions: AlemiCallOptions = {
    ...(options.config !== undefined ? { config: options.config } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    timeoutMs: options.timeoutMs || 6_000,
  };
  try {
    const data = await callAlemiCommand(instanceId, "order.context.get", { order_id: cleanOrderId, limit: 1 }, callOptions);
    const fresh = freshFromContext(data, cleanOrderId, "order_id");
    if (fresh) return fresh;
  } catch (error: any) {
    auditDecision("Fresh order context by order_id unavailable", {
      instanceId,
      orderId: cleanOrderId,
      status: Number(error?.statusCode || 0) || null,
      error: String(error?.message || error).slice(0, 120),
    });
  }
  const phone = e164(options.phone || "");
  if (!phone) return null;
  try {
    const legacy = mapLegacyAlemiAction("get_order_context", { phone });
    const data = await callAlemiCommand(instanceId, legacy.command, legacy.data, callOptions);
    return freshFromContext(data, cleanOrderId, "phone");
  } catch (error) {
    auditError("Fresh order context read failed", error, { instanceId, orderId: cleanOrderId });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface PaymentView {
  timing: PaymentTiming | null;
  revision: number;
  receiptRequired: boolean | null;
}

// The newest knowledge wins; a fresh hub read wins a tie because it is the
// current truth, not a remembered one.
export function currentPaymentView(
  event: PaymentFields | null,
  stored: Pick<StoredPaymentState, "timing" | "revision" | "receiptRequired"> | null,
  fresh: PaymentFields | null,
): PaymentView {
  const candidates: Array<{ view: PaymentView; priority: number }> = [];
  if (event?.revision) candidates.push({ view: { timing: event.timing, revision: event.revision, receiptRequired: event.receiptRequired }, priority: 0 });
  if (stored?.revision) candidates.push({ view: { timing: stored.timing, revision: stored.revision, receiptRequired: stored.receiptRequired }, priority: 1 });
  if (fresh?.revision) candidates.push({ view: { timing: fresh.timing, revision: fresh.revision, receiptRequired: fresh.receiptRequired }, priority: 2 });
  if (!candidates.length) {
    const timing = fresh?.timing || stored?.timing || event?.timing || null;
    const receiptRequired = fresh?.receiptRequired ?? stored?.receiptRequired ?? event?.receiptRequired ?? null;
    return { timing, revision: 0, receiptRequired };
  }
  candidates.sort((a, b) => (b.view.revision - a.view.revision) || (b.priority - a.priority));
  return candidates[0].view;
}

// Statuses that clearly mean "the order moved on" - preparing, handed over,
// finished or cancelled. A payment request arriving for such an order is late.
// Unknown statuses do not block: a renamed hub status must not silence the
// classic prepayment flow.
const PROGRESSED_STATUSES = new Set([
  "paid", "preparing", "cooking", "in_progress", "accepted_kitchen", "ready", "ready_for_pickup",
  "delivery", "on_the_way", "on_delivery", "in_delivery", "delivering", "courier",
  "completed", "done", "finished", "delivered", "closed",
  "cancelled", "canceled", "rejected", "refunded",
]);

export function isProgressedOrderStatus(status: unknown) {
  return PROGRESSED_STATUSES.has(String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

const INACTIVE_STATUSES = new Set(["completed", "done", "finished", "delivered", "closed", "cancelled", "canceled", "rejected", "refunded"]);
export function isInactiveOrderStatus(status: unknown) {
  return INACTIVE_STATUSES.has(String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "_"));
}

export type PaymentRequestAction = "send_requisites" | "send_on_receipt_accept" | "skip";

export interface PaymentRequestDecision {
  action: PaymentRequestAction;
  reason: string;
  view: PaymentView;
}

// request_payment covers two hub shapes: the operator's confirm expressed as a
// status (order.confirmed / status=confirmed) and the explicit receipt request
// order.external_document_requested (first request and "Запросить снова").
export function decidePaymentRequest(input: {
  isReceiptRequest: boolean;
  event: PaymentFields;
  stored: Pick<StoredPaymentState, "timing" | "revision" | "receiptRequired"> | null;
  fresh: { status: string; fields: PaymentFields } | null;
}): PaymentRequestDecision {
  const view = currentPaymentView(input.event, input.stored, input.fresh?.fields || null);
  if (input.event.revision && view.revision > input.event.revision) {
    return { action: "skip", reason: "stale_payment_revision", view };
  }
  if (input.fresh?.status && isInactiveOrderStatus(input.fresh.status)) {
    return { action: "skip", reason: "order_inactive", view };
  }
  if (view.timing === "on_receipt") {
    // The hub forbids receipt requests for such orders; a receipt request that
    // still arrives is a leftover of the previous revision.
    if (input.isReceiptRequest) return { action: "skip", reason: "on_receipt_no_receipt", view };
    return { action: "send_on_receipt_accept", reason: "on_receipt", view };
  }
  if (input.isReceiptRequest) {
    if (input.fresh?.status && isProgressedOrderStatus(input.fresh.status)) {
      return { action: "skip", reason: "order_not_pending", view };
    }
    if (view.receiptRequired === false) return { action: "skip", reason: "receipt_not_required", view };
  }
  return { action: "send_requisites", reason: view.timing ? "prepay" : "legacy_prepay", view };
}

export type TimingChangeAction = "notify" | "skip";

export function decideTimingChangeNotice(input: {
  event: PaymentFields;
  stored: Pick<StoredPaymentState, "timing" | "revision" | "receiptRequired"> | null;
  fresh: { status: string; fields: PaymentFields } | null;
}): { action: TimingChangeAction; reason: string; view: PaymentView } {
  const view = currentPaymentView(input.event, input.stored, input.fresh?.fields || null);
  if (!view.timing) return { action: "skip", reason: "timing_unknown", view };
  if (input.event.revision && view.revision > input.event.revision) {
    return { action: "skip", reason: "stale_payment_revision", view };
  }
  if (input.fresh?.status && isInactiveOrderStatus(input.fresh.status)) {
    return { action: "skip", reason: "order_inactive", view };
  }
  return { action: "notify", reason: view.timing, view };
}

// ---------------------------------------------------------------------------
// Guest texts
// ---------------------------------------------------------------------------

function amountLine(total: number | null | undefined, lang: Language) {
  const amount = positiveAmount(total);
  if (!amount) return "";
  return lang === "ru" ? `💰 Сумма: *${amount} ₸*\n` : `💰 Сомасы: *${amount} ₸*\n`;
}

// One line appended to the order.created summary of an on_receipt order.
export function onReceiptNewOrderLine(lang: Language) {
  return lang === "ru"
    ? "💵 *Оплата:* при получении заказа — переводить заранее не нужно."
    : "💵 *Төлем:* тапсырысты алған кезде — алдын ала аударудың қажеті жоқ.";
}

// The operator pressed «Принять и готовить» on an on_receipt order: the guest
// hears the sum and that they pay on receipt - never requisites, never "send the
// receipt".
export function buildOnReceiptAcceptedMessage(total: number | null | undefined, lang: Language) {
  if (lang === "ru") {
    return `✅ *Всё в наличии! Заказ принят и готовится* 🍳\n${amountLine(total, lang)}💵 *Оплата при получении* — переводить заранее и отправлять чек не нужно.`;
  }
  return `✅ *Бәрі бар! Тапсырысыңыз қабылданды, дайындалып жатыр* 🍳\n${amountLine(total, lang)}💵 *Төлем — алған кезде*: алдын ала аудару да, чек жіберу де қажет емес.`;
}

export function onReceiptStatusSuffix(lang: Language) {
  return lang === "ru" ? "💵 Оплата при получении." : "💵 Төлем — тапсырысты алған кезде.";
}

export function buildPaymentTimingChangedMessage(
  timing: PaymentTiming,
  input: { orderNumber?: string; total?: number | null },
  lang: Language,
) {
  const number = String(input.orderNumber || "").trim();
  if (timing === "on_receipt") {
    if (lang === "ru") {
      return `💵 *Способ оплаты изменён: оплата при получении.*\n${number ? `Заказ №${number}\n` : ""}${amountLine(input.total, lang)}\nПредоплату и чек отправлять не нужно — оплатите, когда получите заказ. Если вы уже перевели деньги, напишите в этот чат — разберёмся.`;
    }
    return `💵 *Төлем тәсілі өзгерді: тапсырысты алған кезде төлейсіз.*\n${number ? `№${number} тапсырыс\n` : ""}${amountLine(input.total, lang)}\nАлдын ала төлеу мен чек жіберудің қажеті жоқ — тапсырысты алған кезде төлейсіз. Ақшаны аударып қойған болсаңыз, осы чатқа жазыңыз — реттейміз.`;
  }
  if (lang === "ru") {
    return `💳 *Способ оплаты изменён: предоплата.*\n${number ? `Заказ №${number}\n` : ""}${amountLine(input.total, lang)}\nРеквизиты для перевода пришлём в этот чат — после оплаты отправьте сюда чек.`;
  }
  return `💳 *Төлем тәсілі өзгерді: алдын ала төлеу.*\n${number ? `№${number} тапсырыс\n` : ""}${amountLine(input.total, lang)}\nАудару реквизиттерін осы чатқа жібереміз — төлегеннен кейін чекті осында жіберіңіз.`;
}

// A receipt photo for an order the guest pays on receipt: nothing to verify.
export function buildReceiptNotNeededReply(lang: Language, orderNumber = "") {
  const number = String(orderNumber || "").trim();
  if (lang === "ru") {
    return `💵 ${number ? `Заказ №${number} оплачивается` : "Этот заказ оплачивается"} при получении — чек отправлять не нужно. Если вы уже перевели деньги, напишите об этом здесь — разберёмся.`;
  }
  return `💵 ${number ? `№${number} тапсырыс` : "Бұл тапсырыс"} алған кезде төленеді — чек жіберудің қажеті жоқ. Ақшаны аударып қойған болсаңыз, осында жазыңыз — реттейміз.`;
}

// Hub answered 409: the receipt belongs to an older payment cycle.
export function buildStaleReceiptReply(lang: Language, timing: PaymentTiming | null, orderNumber = "") {
  if (timing === "on_receipt") return buildReceiptNotNeededReply(lang, orderNumber);
  return lang === "ru"
    ? "🧾 Условия оплаты по заказу изменились, поэтому этот чек не прикрепился. Дождитесь актуальных реквизитов в этом чате и после оплаты отправьте новый чек."
    : "🧾 Тапсырыстың төлем шарты өзгерді, сондықтан бұл чек тіркелмеді. Осы чатқа жаңа реквизиттер келгенін күтіп, төлегеннен кейін жаңа чекті жіберіңіз.";
}

// The receipt lane fixes the revision at the moment the guest's message
// arrives: the stored (webhook-fed) state and the order record preloaded for
// this turn, whichever is newer.
export async function paymentViewAtIntake(
  instanceId: string,
  orderId: string,
  orderRecord: unknown,
): Promise<PaymentView> {
  const cleanOrderId = String(orderId || "").trim();
  const fromOrder = paymentFieldsFrom(orderRecord);
  if (!instanceId || !cleanOrderId) return currentPaymentView(null, null, fromOrder);
  const stored = await getPaymentState(instanceId, cleanOrderId);
  return currentPaymentView(null, stored, fromOrder);
}

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { getRuntimeStatus, normalizePhone } from "../services/dle.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import {
  connectRedis,
  deleteShiftNote,
  getKitchenStatus,
  redisClient,
  saveKitchenStatus,
  saveShiftNote,
  saveToHistory,
} from "../services/redis.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { auditDecision, auditError, auditOutbound, auditProcessing } from "../services/auditLogger.service.js";

type Language = "kk" | "ru";
type PaymentDetail = { label: string; value: string; source?: string };

const INSTANCE_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const ORDER_ID_RE = /^\d{1,12}$/;
const VALID_ACTIONS = new Set([
  "new_order",
  "status_changed",
  "request_payment",
  "order_rejected",
  "shift_note_created",
  "shift_note_deleted",
  "update_kitchen_status",
  "get_kitchen_status",
  "developer_alert",
  "complaint",
]);

const statusTemplates: Record<Language, Record<string, string>> = {
  kk: {
    review: "Чек тексерілуде. Оператор растаған соң дайындаймыз.",
    paid: "Төлем расталды, тапсырысыңыз қабылданды. Дайындалып жатыр.",
    delivery: "Тапсырысыңыз курьерге берілді, жеткізу жолында.",
    completed: "Тапсырыс сәтті аяқталды, асыңыз дәмді болсын!",
    pickup_ready: "Тапсырысыңыз дайын. Келіп алып кетуіңізге болады.",
    cancelled: "Тапсырысыңыздан бас тартылды. Қажет болса, мәзір арқылы жаңа тапсырыс бере аласыз.",
  },
  ru: {
    review: "Чек проверяется. Как только оператор подтвердит, начнем готовить.",
    paid: "Оплата подтверждена, заказ принят. Готовим.",
    delivery: "Ваш заказ передан курьеру и уже в пути.",
    completed: "Заказ успешно завершен, приятного аппетита!",
    pickup_ready: "Ваш заказ готов. Можете забирать.",
    cancelled: "Ваш заказ отменен. При необходимости можете оформить новый заказ через меню.",
  },
};

function textValue(value: unknown, fallback = ""): string {
  return String(value ?? fallback).trim();
}

function cleanInline(value: unknown, max = 200): string {
  return textValue(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, max).trim();
}

function cleanCommentPrefix(value: unknown): string {
  const s = cleanInline(value, 220);
  const regex = /(комментарий|коммент|пожелание|примечание|пікір|ескерту|түсініктеме)\s*[:\-]?\s*/giu;
  return s.replace(regex, "").trim();
}

function numberValue(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function boolValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = textValue(value).toLowerCase();
  if (["1", "true", "yes", "on", "pickup"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
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
        label: cleanInline(source.label || source.name || source.title || "Реквизит", 60),
        value: cleanInline(source.value || source.number || source.url || source.link || "", 250),
        source: source.source ? cleanInline(source.source, 40) : undefined,
      };
    })
    .filter((item) => item.value)
    .slice(0, 12);
}

function paymentDetailsFromConfig(config: Record<string, unknown>): PaymentDetail[] {
  for (const key of ["payment_details", "paymentDetails", "requisites", "requisite_details", "payment_requisites"]) {
    const details = normalizePaymentDetails(config[key]);
    if (details.length) return details;
  }

  return normalizePaymentDetails([
    { label: "Kaspi", value: config.kaspi_info || config.kaspi || config.kaspi_number || config.kaspi_phone },
    { label: "Halyk", value: config.halyk_info || config.halyk || config.halyk_number || config.halyk_phone },
    { label: "QR", value: config.payment_qr || config.qr || config.qr_link },
  ]);
}

function paymentDetailsText(details: PaymentDetail[], lang: Language): string {
  if (!details.length) {
    return lang === "ru"
      ? "Реквизиты пока не настроены. Пожалуйста, подождите ответ оператора."
      : "Реквизиттер әзірге бапталмаған. Оператор жауабын күте тұрыңыз.";
  }
  return details.map((item) => `${item.label}: ${item.value}`).join("\n");
}

function paymentDetailsFromRuntime(runtimeStatus: Record<string, unknown> | null): PaymentDetail[] {
  if (!runtimeStatus) return [];
  const kitchen = runtimeStatus.kitchen_status && typeof runtimeStatus.kitchen_status === "object"
    ? (runtimeStatus.kitchen_status as Record<string, unknown>)
    : {};
  return normalizePaymentDetails(runtimeStatus.payment_details || kitchen.payment_details);
}

async function getLiveRuntimeStatus(instance: string, config: Record<string, unknown>) {
  const domain = textValue(config.domain || config.website || config.url);
  if (!domain) return null;
  return getRuntimeStatus(instance, domain, { forceFresh: true }).catch((error: unknown) => {
    auditError("Runtime status read failed", error, { instance, domain });
    return null;
  });
}

function getLanguage(body: Record<string, unknown>): Language {
  return textValue(body.lang || body.language).toLowerCase() === "ru" ? "ru" : "kk";
}

function normalizeItems(value: unknown): Array<{ name: string; qty: number; price: number; total: number }> {
  return parseJsonArray(value)
    .map((item) => {
      const source = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      const qty = Math.min(99, Math.max(1, numberValue(source.qty || source.count || source.quantity, 1)));
      const price = Math.max(0, numberValue(source.price, 0));
      return {
        name: cleanInline(source.name || source.title || source.product_name || "Тауар", 80),
        qty,
        price,
        total: Math.max(0, numberValue(source.total || source.sum, price * qty)),
      };
    })
    .filter((item) => item.name)
    .slice(0, 50);
}

function buildCartText(body: Record<string, unknown>): string {
  const items = normalizeItems(body.items || body.goods || body.products);
  if (items.length) {
    return items.map((item) => `- ${item.name} x${item.qty} = ${item.total || item.price * item.qty} ₸`).join("\n");
  }
  const cartList = cleanInline(body.cart_list, 3000);
  return cartList || "- Тапсырыс тізімі табылмады";
}

function buildNewOrderMessage(body: Record<string, unknown>, lang: Language, orderId: string, isPickup: boolean): string {
  const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
  const address = cleanInline(body.address || (lang === "ru" ? "Не указан" : "Көрсетілмеген"), 200);
  const rawComment = cleanInline(body.comment || body.info, 500);
  const persons = numberValue(body.persons, 0);
  const bonus = numberValue(body.bonus, 0);
  const lines =
    lang === "ru"
      ? [`Ваш заказ №${orderId} принят!`, isPickup ? "Тип: самовывоз" : `Адрес: ${address}`]
      : [`№${orderId} тапсырысыңыз қабылданды!`, isPickup ? "Түрі: алып кету" : `Мекенжай: ${address}`];

  if (bonus > 0) lines.push(lang === "ru" ? `Списанный бонус: ${bonus} ₸` : `Жұмсалған бонус: ${bonus} ₸`);
  if (persons > 0) lines.push(lang === "ru" ? `Количество персон: ${persons}` : `Адам саны: ${persons}`);
  if (rawComment) lines.push(lang === "ru" ? `Комментарий: ${rawComment}` : `Пікір: ${rawComment}`);

  lines.push("", lang === "ru" ? "Состав заказа:" : "Тапсырыс құрамы:", buildCartText(body));
  lines.push("", lang === "ru" ? `Итого: ${totalAmount} ₸` : `Барлығы: ${totalAmount} ₸`);
  lines.push(
    lang === "ru"
      ? "Мы проверяем наличие на кухне, пожалуйста, ожидайте 1-2 минуты."
      : "Біз ас үйде бар-жоғын тексеріп жатырмыз, 1-2 минут күте тұрыңыз."
  );
  return lines.join("\n");
}

async function buildPaymentMessage(
  body: Record<string, unknown>,
  config: Record<string, unknown>,
  lang: Language,
  instance: string
): Promise<string> {
  const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
  const runtimeStatus = await getLiveRuntimeStatus(instance, config);
  const payloadDetails = normalizePaymentDetails(body.payment_details || body.paymentDetails || body.requisites);
  const runtimeDetails = paymentDetailsFromRuntime(runtimeStatus);
  const configDetails = paymentDetailsFromConfig(config);
  const paymentInfo = paymentDetailsText(payloadDetails.length ? payloadDetails : runtimeDetails.length ? runtimeDetails : configDetails, lang);

  if (lang === "ru") {
    return `Все в наличии!\nСумма к оплате: ${totalAmount} ₸\n\nОплата:\n${paymentInfo}\n\nПожалуйста, отправьте чек об оплате в этот чат.`;
  }
  return `Бәрі бар!\nТөлем сомасы: ${totalAmount} ₸\n\nТөлем жасау:\n${paymentInfo}\n\nТөлем жасағаннан кейін чекті осы чатқа жіберіңіз.`;
}

function buildRejectedMessage(body: Record<string, unknown>, lang: Language): string {
  const reason = cleanInline(body.reason || (lang === "ru" ? "Неизвестная причина" : "Белгісіз себеп"), 200);
  return lang === "ru"
    ? `К сожалению, мы не сможем приготовить заказ.\nПричина: ${reason}.\nПожалуйста, выберите другое блюдо.`
    : `Өкінішке қарай, тапсырысты дайындай алмаймыз.\nСебебі: ${reason}.\nБасқа тағам таңдауыңызды сұраймыз.`;
}

function legacyPaymentDetailsFromPayloadRuntimeOrConfig(
  body: Record<string, unknown>,
  runtimeStatus: Record<string, unknown> | null,
  config: Record<string, unknown>
): PaymentDetail[] {
  const payloadDetails = normalizePaymentDetails(body.payment_details || body.paymentDetails || body.requisites);
  if (payloadDetails.length) return payloadDetails;
  const runtimeDetails = paymentDetailsFromRuntime(runtimeStatus);
  if (runtimeDetails.length) return runtimeDetails;
  return paymentDetailsFromConfig(config);
}

function legacyPaymentDetailsSource(
  body: Record<string, unknown>,
  runtimeStatus: Record<string, unknown> | null,
  config: Record<string, unknown>
): string {
  if (normalizePaymentDetails(body.payment_details || body.paymentDetails || body.requisites).length) return "payload";
  if (paymentDetailsFromRuntime(runtimeStatus).length) return "runtime";
  if (paymentDetailsFromConfig(config).length) return "nocodb_fallback";
  return "not_configured";
}

export function buildLegacyNewOrderMessage(body: Record<string, unknown>, lang: Language, orderId: string, isPickup: boolean): string {
  let rawComment = String(body.comment || body.info || "");
  let extractedBonus = 0;
  let extractedPersons = 0;

  const bonusMatch = rawComment.match(/\[(?:Списано|Бонус|Шегерілді)\s*:?\s*(\d+)\s*(?:Б|₸)?[^\]]*\]/iu);
  if (bonusMatch) {
    extractedBonus = Number(bonusMatch[1]);
    rawComment = rawComment.replace(bonusMatch[0], "");
  }

  const personsMatch = rawComment.match(/(?:Приборы|Персон|Адам саны)\s*:\s*(\d+)/iu);
  if (personsMatch) {
    extractedPersons = Number(personsMatch[1]);
    rawComment = rawComment.replace(/(?:Приборы|Персон|Адам саны)\s*:\s*\d+\s*(?:шт)?/iu, "");
  }

  rawComment = rawComment.replace(/\|\s*(?:Коммент|Комментарий|Пікір)?\s*:?/giu, "").replace(/^[\s|]+|[\s|]+$/g, "").trim();
  const comment = cleanCommentPrefix(rawComment);
  const bonusNum = Number(body.bonus) || extractedBonus;
  const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
  const persons = Number(body.persons) || extractedPersons;
  let cartText = "";
  let items: unknown = body.items || body.goods || body.products || [];

  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }

  if (Array.isArray(items) && items.length > 0) {
    cartText = items.slice(0, 50).map((item: any) => {
      const name = cleanInline(item?.name || item?.title || (lang === "ru" ? "Товар" : "Тауар"), 80);
      const qty = Math.min(99, Math.max(1, Number(item?.qty || item?.count || item?.quantity || 1)));
      const price = Math.max(0, Number(item?.price || 0));
      const total = Math.max(0, Number(item?.total || item?.sum || price * qty));
      return `▪️ ${name} x${qty} = ${total} ₸`;
    }).join("\n");
  } else if (typeof body.cart_list === "string" && body.cart_list.length > 2) {
    cartText = body.cart_list.slice(0, 3000);
  } else {
    cartText = lang === "ru" ? "▪️ (Состав заказа не найден)" : "▪️ (Тапсырыс тізімі табылмады)";
  }

  let textMessage = "";
  if (lang === "ru") {
    textMessage = `🛍 *Ваш заказ №${orderId} принят!*\n`;
    if (isPickup) textMessage += "🏃 *Тип:* Самовывоз\n";
    else textMessage += `📍 *Адрес:* ${cleanInline(body.address || "Не указан", 200)}\n`;
    if (bonusNum > 0) textMessage += `🎁 *Потраченный бонус:* ${bonusNum} ₸\n`;
    if (persons > 0) textMessage += `🍴 *Количество персон:* ${persons}\n`;
    if (comment) textMessage += `💬 *Комментарий:* ${comment}\n`;
    textMessage += `\n🛒 *Состав заказа:*\n${cartText}\n`;
    textMessage += `➖➖➖➖➖➖➖\n💰 *ИТОГО: ${totalAmount} ₸*\n➖➖➖➖➖➖➖\n\n`;
    textMessage += "⏳ *Внимание:* Мы проверяем наличие на кухне, пожалуйста, ожидайте 1-2 минуты...";
  } else {
    textMessage = `🛍 *№${orderId} тапсырысыңыз қабылданды!*\n`;
    if (isPickup) textMessage += "🏃 *Түрі:* Алып кету (Самовывоз)\n";
    else textMessage += `📍 *Мекенжай:* ${cleanInline(body.address || "Көрсетілмеген", 200)}\n`;
    if (bonusNum > 0) textMessage += `🎁 *Жұмсалған бонус:* ${bonusNum} ₸\n`;
    if (persons > 0) textMessage += `🍴 *Адам саны:* ${persons}\n`;
    if (comment) textMessage += `💬 *Пікір:* ${comment}\n`;
    textMessage += `\n🛒 *Тапсырыс құрамы:*\n${cartText}\n`;
    textMessage += `➖➖➖➖➖➖➖\n💰 *БАРЛЫҒЫ: ${totalAmount} ₸*\n➖➖➖➖➖➖➖\n\n`;
    textMessage += "⏳ *Назарыңызға:* Біз ас үйде бар-жоғын тексеріп жатырмыз, 1-2 минут күте тұрыңыз...";
  }
  return textMessage;
}

async function buildLegacyPaymentMessage(
  body: Record<string, unknown>,
  config: Record<string, unknown>,
  lang: Language,
  instance: string
): Promise<string> {
  const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
  const liveRuntimeStatus = await getLiveRuntimeStatus(instance, config || {});
  const paymentDetails = legacyPaymentDetailsFromPayloadRuntimeOrConfig(body, liveRuntimeStatus, config || {});
  const paymentInfo = paymentDetailsText(paymentDetails, lang);
  auditDecision("Payment details resolved", {
    instance,
    source: legacyPaymentDetailsSource(body, liveRuntimeStatus, config || {}),
    count: paymentDetails.length,
  });
  return formatLegacyPaymentMessage(totalAmount, paymentInfo, lang);
}

export function formatLegacyPaymentMessage(totalAmount: string, paymentInfo: string, lang: Language): string {
  if (lang === "ru") {
    return `✅ *Всё в наличии!*\n💰 Сумма к оплате: *${totalAmount} ₸*\n\n💳 *Оплата:*\n${paymentInfo}\n\n🧾 *После оплаты отправьте чек в этот чат 👇*`;
  }
  return `✅ *Бәрі бар!*\n💰 Төлем сомасы: *${totalAmount} ₸*\n\n💳 *Төлем жасау:*\n${paymentInfo}\n\n🧾 *Төлем жасағаннан кейін чекті осы чатқа жіберіңіз 👇*`;
}

export function buildLegacyRejectedMessage(body: Record<string, unknown>, lang: Language): string {
  const reason = cleanInline(body.reason || (lang === "ru" ? "Неизвестная причина" : "Белгісіз себеп"), 200);
  return lang === "ru"
    ? `❌ К сожалению, мы не сможем приготовить заказ.\nПричина: *${reason}*.\nПожалуйста, выберите другое блюдо.`
    : `❌ Өкінішке қарай, тапсырысты дайындай алмаймыз.\nСебебі: *${reason}*.\nБасқа тағам таңдауыңызды сұраймыз.`;
}

export const legacyStatusTemplates: Record<Language, Record<string, string>> = {
  kk: {
    review: "⏳ Чек тексерілуде. Оператор растаған соң дайындаймыз.",
    paid: "✅ Төлем расталды, тапсырысыңыз қабылданды. Дайындалуда! 🍳",
    delivery: "🛵 Тапсырысыңыз курьерге берілді, жеткізу жолында.",
    completed: "🎉 Тапсырыс сәтті аяқталды, асыңыз дәмді болсын!",
    pickup_ready: "✅ Тапсырысыңыз дайын! Келіп алып кетуіңізге болады.",
    cancelled: "❌ Тапсырысыңыздан бас тартылды. Қажет болса, мәзір арқылы жаңа тапсырыс бере аласыз.",
  },
  ru: {
    review: "⏳ Чек проверяется. Как только оператор подтвердит, начнём готовить.",
    paid: "✅ Оплата подтверждена, заказ принят. Готовим! 🍳",
    delivery: "🛵 Ваш заказ передан курьеру и уже в пути.",
    completed: "🎉 Заказ успешно завершён, приятного аппетита!",
    pickup_ready: "✅ Ваш заказ готов! Можете забирать.",
    cancelled: "❌ Ваш заказ отменён. При необходимости можете оформить новый заказ через меню.",
  },
};

function extractShiftNotePayload(body: Record<string, unknown>) {
  const noteId = cleanInline(body.note_id || body.noteId || body.id, 80);
  const text = textValue(body.text || body.note_text || body.note || body.message);
  const expiresAt = cleanInline(body.expires_at || body.expiresAt || body.expires || body.until, 80);
  const shiftKey = cleanInline(body.shift_key || body.shiftKey, 80);
  const stableLockId =
    noteId && noteId !== "0"
      ? noteId
      : `fallback_${crypto.createHash("sha1").update(`${body.action || ""}|${shiftKey}|${text}|${expiresAt}`).digest("hex").slice(0, 16)}`;
  return { noteId, text, expiresAt, shiftKey, stableLockId };
}

function getDeveloperPhone(config: Record<string, unknown>) {
  return normalizePhone(config.dev_phone || "");
}

function getAdminPhone(config: Record<string, unknown>) {
  return normalizePhone(config.admin_phone || "");
}

async function notifyDeveloper(instance: string, error: unknown, meta: Record<string, unknown>) {
  await notifyDeveloperSystemFailure(instance, error, { scope: "kanban_webhook", ...meta }).catch(() => undefined);
}

async function notifyComplaint(body: Record<string, unknown>, config: Record<string, unknown>, instance: string) {
  const adminPhone = getAdminPhone(config);
  if (!adminPhone) {
    auditDecision("Complaint notification skipped: admin phone missing", { instance });
    return false;
  }
  const phone = normalizePhone(body.phone || body.customer_phone || "");
  const orderId = cleanInline(body.order_id || body.orderId || "Табылмады", 40);
  const restaurant = cleanInline(config.name || config.restaurant_name || instance, 120);
  const summary = cleanInline(body.admin_summary || body.summary || body.reason || body.text || body.message, 600);
  const message = [
    "ЖАҢА ШАҒЫМ",
    `Ресторан: ${restaurant}`,
    phone ? `Клиент: +${phone}` : "",
    `Тапсырыс №: ${orderId}`,
    "",
    `AI анализі: ${summary || "Клиент шағым қалдырды."}`,
  ].filter(Boolean).join("\n");

  auditOutbound("Triggering WhatsApp complaint notification", {
    instance,
    phone: adminPhone,
    text: message,
  });
  await sendWhatsProMessage({ instanceId: instance, phone: adminPhone, text: message });
  return true;
}

async function emitPrintOnPaid(req: Request, body: Record<string, unknown>, status: string) {
  if (status !== "paid") {
    auditDecision("Print trigger skipped: status is not paid", {
      orderId: body.order_id,
      status,
    });
    return;
  }
  const io = req.app.get("io");
  if (io && typeof io.emit === "function") {
    auditDecision("Print trigger emitted for paid status", {
      orderId: body.order_id,
      status,
    });
    io.emit("print_new_order", body);
  } else {
    auditDecision("Print trigger skipped: socket server unavailable", {
      orderId: body.order_id,
      status,
    });
  }
}

async function emitPrintOnNewOrder(req: Request, body: Record<string, unknown>, action: string) {
  if (action !== "new_order") {
    auditDecision("Print trigger skipped: action is not new_order", {
      orderId: body.order_id,
      action,
    });
    return;
  }
  const io = req.app.get("io");
  if (io && typeof io.emit === "function") {
    auditDecision("Print trigger emitted for new order", {
      orderId: body.order_id,
      action,
    });
    io.emit("print_new_order", body);
  } else {
    auditDecision("Print trigger skipped: socket server unavailable", {
      orderId: body.order_id,
      action,
    });
  }
}

async function sendAndRemember(instance: string, phone: string, text: string): Promise<void> {
  auditOutbound("Triggering WhatsApp customer notification", {
    instance,
    phone,
    text,
  });
  await sendWhatsProMessage({ instanceId: instance, phone, text });
  auditDecision("Saving bot notification to Redis history", {
    instance,
    phone,
    textLength: text.length,
  });
  await saveToHistory(instance, phone, "model", `<bot_notification>\n${text}\n</bot_notification>`);
}

export async function handleKanbanWebhook(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const instance = cleanInline(body.instance, 80);
  const action = cleanInline(body.action, 80);
  const rawOrderId = cleanInline(body.order_id || body.orderId || body.id || "0", 40);
  let lockKey = "";
  let lockAcquired = false;

  auditProcessing("Kanban webhook processing started", {
    orderId: rawOrderId,
    stage: action,
    action,
    instance,
    phone: body.phone,
    new_status: body.new_status || body.status || body.order_status,
    total_price: body.total_price || body.total,
    is_pickup: body.is_pickup || body.isPickup,
    source: body.source,
    event_time: body.event_time,
  });

  try {
    if (!INSTANCE_RE.test(instance)) {
      auditDecision("Rejected webhook: invalid instance", { orderId: rawOrderId, action, instance });
      res.status(400).json({ ok: false, error: "BAD_INSTANCE" });
      return;
    }
    if (!VALID_ACTIONS.has(action)) {
      auditDecision("Rejected webhook: invalid action", { orderId: rawOrderId, action, instance });
      res.status(400).json({ ok: false, error: "BAD_ACTION" });
      return;
    }

    if (action === "update_kitchen_status") {
      auditDecision("Updating kitchen status in Redis", {
        instance,
        wait_time: body.wait_time,
        hours_valid: body.hours_valid || body.hoursValid,
        reset_at: body.reset_at || body.resetAt,
      });
      const status = await saveKitchenStatus(instance, body);
      auditDecision("Kitchen status updated", { instance, status });
      res.status(200).json({ success: true, status });
      return;
    }

    if (action === "get_kitchen_status") {
      auditDecision("Reading kitchen status from Redis", { instance });
      const status = await getKitchenStatus(instance);
      auditDecision("Kitchen status read complete", { instance, found: Boolean(status), status });
      res.status(200).json({ success: true, status });
      return;
    }

    auditDecision("Loading restaurant config", { instance, action, orderId: rawOrderId });
    const config = (await getRestaurantConfig(instance)) || {};
    auditDecision("Restaurant config loaded", {
      instance,
      action,
      orderId: rawOrderId,
      hasDeveloperPhone: Boolean(getDeveloperPhone(config)),
      hasAdminPhone: Boolean(getAdminPhone(config)),
    });

    if (action === "developer_alert") {
      const message = cleanInline(body.error || body.message || body.reason || "developer_alert", 600);
      auditDecision("Triggering developer alert", { instance, orderId: body.order_id, message });
      await notifyDeveloper(instance, new Error(message), { source: "developer_alert", orderId: body.order_id });
      res.status(200).json({ success: true, message: "Developer notified" });
      return;
    }

    if (action === "complaint") {
      auditDecision("Routing complaint to admin", { instance, orderId: rawOrderId, phone: body.phone });
      const sent = await notifyComplaint(body, config, instance);
      auditDecision("Complaint routing complete", { instance, orderId: rawOrderId, admin_notified: sent });
      res.status(200).json({ success: true, admin_notified: sent });
      return;
    }

    const isShiftNoteAction = action.startsWith("shift_note_");
    const phone = normalizePhone(body.phone || "");
    const orderId = cleanInline(body.order_id || body.orderId || body.id || "0", 40);
    const newStatus = cleanInline(body.status || body.new_status || body.order_status, 80);
    const isPickup = boolValue(body.is_pickup, false);

    if (!isShiftNoteAction) {
      if (!ORDER_ID_RE.test(orderId) || orderId === "0") {
        auditDecision("Rejected webhook: invalid order id", { orderId, action, instance });
        res.status(400).json({ ok: false, error: "BAD_ORDER_ID" });
        return;
      }
      if (!phone) {
        auditDecision("Rejected webhook: invalid phone", { orderId, action, instance, rawPhone: body.phone });
        res.status(400).json({ ok: false, error: "BAD_PHONE" });
        return;
      }
      auditDecision("Order payload validated", { orderId, action, instance, phone, newStatus, isPickup });
    } else {
      auditDecision("Shift note payload detected", { action, instance });
    }

    auditDecision("Connecting Redis for lock and memory operations", { orderId, action, instance });
    await connectRedis();
    const shiftNotePayload = isShiftNoteAction ? extractShiftNotePayload(body) : null;
    const lockId = shiftNotePayload?.stableLockId || orderId;
    const lockScope = action === "status_changed" ? `${action}:${newStatus || "unknown"}` : action;
    lockKey = `kanban_lock:${instance}:${lockId}:${lockScope}`;
    auditDecision("Attempting idempotency lock", { orderId, action, instance, lockKey, lockScope });
    const locked = await redisClient.set(lockKey, "1", { NX: true, EX: isShiftNoteAction ? 5 : 86400 });
    if (!locked) {
      auditDecision("Found existing order/signal lock; ignoring duplicate", { orderId, action, instance, lockKey });
      res.status(200).json({ success: true, message: "Ignored duplicate signal" });
      return;
    }
    lockAcquired = true;
    auditDecision("Creating new processing record via Redis lock", { orderId, action, instance, lockKey });

    if (action === "shift_note_created" && shiftNotePayload) {
      auditDecision("Saving shift note to AI memory", { instance, shiftNotePayload });
      const saved = await saveShiftNote(instance, shiftNotePayload.noteId, shiftNotePayload.text, shiftNotePayload.expiresAt);
      if (!saved) throw new Error("SHIFT_NOTE_SAVE_FAILED");
      auditDecision("Shift note saved", { instance, shiftNotePayload });
      res.status(200).json({ success: true, message: "Note saved to AI memory" });
      return;
    }

    if (action === "shift_note_deleted" && shiftNotePayload) {
      auditDecision("Deleting shift note from AI memory", { instance, shiftNotePayload });
      await deleteShiftNote(instance, shiftNotePayload.noteId, shiftNotePayload.text);
      auditDecision("Shift note deleted", { instance, shiftNotePayload });
      res.status(200).json({ success: true, message: "Note removed from AI memory" });
      return;
    }

    await emitPrintOnNewOrder(req, body, action);
    await emitPrintOnPaid(req, body, newStatus);

    const lang = getLanguage(body);
    let textMessage = "";
    if (action === "new_order") {
      auditDecision("Building new_order WhatsApp template", { orderId, action, instance, lang, isPickup });
      textMessage = buildLegacyNewOrderMessage(body, lang, orderId, isPickup);
    }
    if (action === "request_payment") {
      auditDecision("Building request_payment WhatsApp template", { orderId, action, instance, lang });
      textMessage = await buildLegacyPaymentMessage(body, config, lang, instance);
    }
    if (action === "order_rejected") {
      auditDecision("Building order_rejected WhatsApp template", { orderId, action, instance, lang });
      textMessage = buildLegacyRejectedMessage(body, lang);
    }
    if (action === "status_changed") {
      const effectiveStatus = newStatus === "completed" && isPickup ? "pickup_ready" : newStatus;
      auditDecision("Resolving status_changed template", { orderId, action, instance, lang, newStatus, effectiveStatus });
      textMessage = legacyStatusTemplates[lang][effectiveStatus] || "";
      if (!textMessage) {
        auditDecision("Status ignored: no client template configured", { orderId, action, instance, lang, newStatus, effectiveStatus });
        res.status(200).json({ success: true, message: "Ignored status not intended for client" });
        return;
      }
    }

    if (textMessage) {
      auditDecision("Triggering WhatsApp notification path", {
        orderId,
        action,
        instance,
        phone,
        textLength: textMessage.length,
      });
      await sendAndRemember(instance, phone, textMessage);
      if (newStatus === "completed" || newStatus === "cancelled" || action === "order_rejected") {
        auditDecision("Cleaning completed/cancelled order Redis history", { orderId, action, instance, phone, newStatus });
        await redisClient.del([`history:${instance}:${phone}`, `last_order:${instance}:${phone}`]).catch(() => undefined);
      }
    } else {
      auditDecision("No outbound WhatsApp template produced", { orderId, action, instance, newStatus });
    }

    auditDecision("Kanban webhook processed successfully", { orderId, action, instance });
    res.status(200).json({ success: true, message: "Processed" });
  } catch (error) {
    auditError("Kanban webhook failed", error, {
      orderId: body.order_id || rawOrderId,
      action,
      instance,
      lockKey,
      lockAcquired,
    });
    if (lockAcquired && lockKey) {
      auditDecision("Releasing idempotency lock after failure", { orderId: body.order_id || rawOrderId, action, instance, lockKey });
      await redisClient.del(lockKey).catch(() => undefined);
    }

    await notifyDeveloper(instance, error, {
      orderId: body.order_id,
      action,
    });

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error || "kanban webhook failed"),
      });
    }
  }
}

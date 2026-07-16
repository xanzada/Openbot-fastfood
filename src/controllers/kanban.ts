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
  const regex = /(РєРѕРјРјРµРЅС‚Р°СЂРёР№|РєРѕРјРјРµРЅС‚|РїРѕР¶РµР»Р°РЅРёРµ|РїСЂРёРјРµС‡Р°РЅРёРµ|РїС–РєС–СЂ|РµСЃРєРµСЂС‚Сѓ|С‚ТЇСЃС–РЅС–РєС‚РµРјРµ)\s*[:\-]?\s*/gi;
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
    console.warn(`[KANBAN] ${instance}: runtime read failed:`, error instanceof Error ? error.message : error);
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

function buildLegacyNewOrderMessage(body: Record<string, unknown>, lang: Language, orderId: string, isPickup: boolean): string {
  let rawComment = String(body.comment || body.info || "");
  let extractedBonus = 0;
  let extractedPersons = 0;

  const bonusMatch = rawComment.match(/\[(?:РЎРїРёСЃР°РЅРѕ|Р‘РѕРЅСѓСЃ)\s*(\d+).*?\]/i);
  if (bonusMatch) {
    extractedBonus = Number(bonusMatch[1]);
    rawComment = rawComment.replace(bonusMatch[0], "");
  }

  const personsMatch = rawComment.match(/(?:РџСЂРёР±РѕСЂС‹|РђРґР°Рј СЃР°РЅС‹):\s*(\d+)/i);
  if (personsMatch) {
    extractedPersons = Number(personsMatch[1]);
    rawComment = rawComment.replace(/(?:РџСЂРёР±РѕСЂС‹|РђРґР°Рј СЃР°РЅС‹):\s*\d+\s*(С€С‚)?/i, "");
  }

  rawComment = rawComment.replace(/\|\s*(РљРѕРјРјРµРЅС‚|РљРѕРјРјРµРЅС‚Р°СЂРёР№|РџС–РєС–СЂ)?\s*:?/gi, "").replace(/^[\s\|]+|[\s\|]+$/g, "").trim();
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
      const name = cleanInline(item?.name || item?.title || "РўР°СѓР°СЂ", 80);
      const qty = Math.min(99, Math.max(1, Number(item?.qty || item?.count || item?.quantity || 1)));
      const price = Math.max(0, Number(item?.price || 0));
      return `в–ЄпёЏ ${name} x${qty} = ${price * qty} в‚ё`;
    }).join("\n");
  } else if (typeof body.cart_list === "string" && body.cart_list.length > 2) {
    cartText = body.cart_list.slice(0, 3000);
  } else {
    cartText = "в–ЄпёЏ (РўР°РїСЃС‹СЂС‹СЃ С‚С–Р·С–РјС– С‚Р°Р±С‹Р»РјР°РґС‹)";
  }

  let textMessage = "";
  if (lang === "ru") {
    textMessage = `рџ›Ѝ*Р’Р°С€ Р·Р°РєР°Р· в„–${orderId} РїСЂРёРЅСЏС‚!*\n`;
    if (isPickup) textMessage += "рџЏѓ *РўРёРї:* РЎР°РјРѕРІС‹РІРѕР·\n";
    else textMessage += `рџ“Ќ *РђРґСЂРµСЃ:* ${cleanInline(body.address || "РќРµ СѓРєР°Р·Р°РЅ", 200)}\n`;
    if (bonusNum > 0) textMessage += `рџЋЃ *РџРѕС‚СЂР°С‡РµРЅРЅС‹Р№ Р‘РѕРЅСѓСЃ:*_${bonusNum} в‚ё_\n`;
    if (persons > 0) textMessage += `рџЌґ *РљРѕР»-РІРѕ РїРµСЂСЃРѕРЅ:* _${persons}_\n`;
    if (comment) textMessage += `рџ’¬ *РљРѕРјРјРµРЅС‚Р°СЂРёР№:* _${comment}_\n`;
    textMessage += `\nрџ›’ *РЎРѕСЃС‚Р°РІ Р·Р°РєР°Р·Р°:*\n${cartText}\n`;
    textMessage += `вћ–вћ–вћ–вћ–вћ–вћ–вћ–\nрџ’° *РРўРћР“Рћ: ${totalAmount} в‚ё*\nвћ–вћ–вћ–вћ–вћ–вћ–вћ–\n\n`;
    textMessage += "вЏі *Р’РЅРёРјР°РЅРёРµ:* РњС‹ РїСЂРѕРІРµСЂСЏРµРј РЅР°Р»РёС‡РёРµ РЅР° РєСѓС…РЅРµ, РїРѕР¶Р°Р»СѓР№СЃС‚Р°, РѕР¶РёРґР°Р№С‚Рµ 1-2 РјРёРЅСѓС‚С‹...";
  } else {
    textMessage = `рџ›Ѝ*в„–${orderId} С‚Р°РїСЃС‹СЂС‹СЃС‹ТЈС‹Р· Т›Р°Р±С‹Р»РґР°РЅРґС‹!*\n`;
    if (isPickup) textMessage += "рџЏѓ *РўТЇСЂС–:* РђР»С‹Рї РєРµС‚Сѓ (РЎР°РјРѕРІС‹РІРѕР·)\n";
    else textMessage += `рџ“Ќ *РњРµРєРµРЅ-Р¶Р°Р№:* ${cleanInline(body.address || "РљУ©СЂСЃРµС‚С–Р»РјРµРіРµРЅ", 200)}\n`;
    if (bonusNum > 0) textMessage += `рџЋЃ *Р–Т±РјСЃР°Р»Т“Р°РЅ Р‘РѕРЅСѓСЃ:*_${bonusNum} в‚ё_\n`;
    if (persons > 0) textMessage += `рџЌґ *РђРґР°Рј СЃР°РЅС‹:* _${persons}_\n`;
    if (comment) textMessage += `рџ’¬ *РџС–РєС–СЂ:* _${comment}_\n`;
    textMessage += `\nрџ›’ *РўР°РїСЃС‹СЂС‹СЃ Т›Т±СЂР°РјС‹:*\n${cartText}\n`;
    textMessage += `вћ–вћ–вћ–вћ–вћ–вћ–вћ–\nрџ’° *Р‘РђР Р›Р«Т’Р«: ${totalAmount} в‚ё*\nвћ–вћ–вћ–вћ–вћ–вћ–вћ–\n\n`;
    textMessage += "вЏі *РќР°Р·Р°СЂС‹ТЈС‹Р·Т“Р°:* Р‘С–Р· Р°СЃ ТЇР№РґРµ Р±Р°СЂ-Р¶РѕТ“С‹РЅ С‚РµРєСЃРµСЂС–Рї Р¶Р°С‚С‹СЂРјС‹Р·, 1-2 РјРёРЅСѓС‚ РєТЇС‚Рµ С‚Т±СЂС‹ТЈС‹Р·...";
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
  console.log(`[KANBAN PAYMENT] ${instance}: details source=${legacyPaymentDetailsSource(body, liveRuntimeStatus, config || {})} count=${paymentDetails.length}`);
  if (lang === "ru") {
    return `вњ… *Р’СЃС‘ РІ РЅР°Р»РёС‡РёРё!*\nрџ’° РЎСѓРјРјР° Рє РѕРїР»Р°С‚Рµ: *${totalAmount} в‚ё*\n\nрџ’і *РћРїР»Р°С‚Р°:*\n${paymentInfo}\n\nрџ§ѕ _РџРѕР¶Р°Р»СѓР№СЃС‚Р°, РѕС‚РїСЂР°РІСЊС‚Рµ С‡РµРє РѕР± РѕРїР»Р°С‚Рµ РІ СЌС‚РѕС‚ С‡Р°С‚ рџ‘‡_`;
  }
  return `вњ… *Р‘У™СЂС– Р±Р°СЂ!*\nрџ’° РўУ©Р»РµРј СЃРѕРјР°СЃС‹: *${totalAmount} в‚ё*\n\nрџ’і *РўУ©Р»РµРј Р¶Р°СЃР°Сѓ:*\n${paymentInfo}\n\nрџ§ѕ _РўУ©Р»РµРј Р¶Р°СЃР°Т“Р°РЅРЅР°РЅ РєРµР№С–РЅ С‡РµРєС‚С– РѕСЃС‹ С‡Р°С‚Т›Р° Р¶С–Р±РµСЂС–ТЈС–Р· рџ‘‡_`;
}

function buildLegacyRejectedMessage(body: Record<string, unknown>, lang: Language): string {
  const reason = cleanInline(body.reason || "Р‘РµР»РіС–СЃС–Р· СЃРµР±РµРї", 200);
  return lang === "ru"
    ? `вќЊ Рљ СЃРѕР¶Р°Р»РµРЅРёСЋ, РјС‹ РЅРµ СЃРјРѕР¶РµРј РїСЂРёРіРѕС‚РѕРІРёС‚СЊ Р·Р°РєР°Р·.\nРџСЂРёС‡РёРЅР°: *${reason}*.\nРџРѕР¶Р°Р»СѓР№СЃС‚Р°, РІС‹Р±РµСЂРёС‚Рµ РґСЂСѓРіРѕРµ Р±Р»СЋРґРѕ.`
    : `вќЊ УЁРєС–РЅС–С€РєРµ РѕСЂР°Р№, С‚Р°РїСЃС‹СЂС‹СЃС‚С‹ РґР°Р№С‹РЅРґР°Р№ Р°Р»РјР°Р№РјС‹Р·.\nРЎРµР±РµР±С–: *${reason}*.\nР‘Р°СЃТ›Р° С‚Р°Т“Р°Рј С‚Р°ТЈРґР°СѓС‹ТЈС‹Р·РґС‹ СЃТ±СЂР°Р№РјС‹Р·.`;
}

const legacyStatusTemplates: Record<Language, Record<string, string>> = {
  kk: {
    review: "вЏі Р§РµРє С‚РµРєСЃРµСЂС–Р»СѓРґРµ. РћРїРµСЂР°С‚РѕСЂ СЂР°СЃС‚Р°Т“Р°РЅ СЃРѕТЈ РґР°Р№С‹РЅРґР°Р№РјС‹Р·.",
    paid: "вњ… РўУ©Р»РµРј СЂР°СЃС‚Р°Р»РґС‹, С‚Р°РїСЃС‹СЂС‹СЃС‹ТЈС‹Р· Т›Р°Р±С‹Р»РґР°РЅРґС‹. Р”Р°Р№С‹РЅРґР°Р»СѓРґР°! рџЌі",
    delivery: "рџ›µ РўР°РїСЃС‹СЂС‹СЃС‹ТЈС‹Р· РєСѓСЂСЊРµСЂРіРµ Р±РµСЂС–Р»РґС–, Р¶РµС‚РєС–Р·Сѓ Р¶РѕР»С‹РЅРґР°.",
    completed: "рџЋ‰ РўР°РїСЃС‹СЂС‹СЃ СЃУ™С‚С‚С– Р°СЏТ›С‚Р°Р»РґС‹, Р°СЃС‹ТЈС‹Р· РґУ™РјРґС– Р±РѕР»СЃС‹РЅ!",
    pickup_ready: "вњ… РўР°РїСЃС‹СЂС‹СЃС‹ТЈС‹Р· РґР°Р№С‹РЅ! РљРµР»С–Рї Р°Р»С‹Рї РєРµС‚СѓС–ТЈС–Р·РіРµ Р±РѕР»Р°РґС‹.",
    cancelled: "вќЊ РўР°РїСЃС‹СЂС‹СЃС‹ТЈС‹Р·РґР°РЅ Р±Р°СЃ С‚Р°СЂС‚С‹Р»РґС‹. ТљР°Р¶РµС‚ Р±РѕР»СЃР°, РјУ™Р·С–СЂ Р°СЂТ›С‹Р»С‹ Р¶Р°ТЈР° С‚Р°РїСЃС‹СЂС‹СЃ СЂУ™СЃС–РјРґРµР№ Р°Р»Р°СЃС‹Р·.",
  },
  ru: {
    review: "вЏі Р§РµРє РїСЂРѕРІРµСЂСЏРµС‚СЃСЏ. РљР°Рє С‚РѕР»СЊРєРѕ РѕРїРµСЂР°С‚РѕСЂ РїРѕРґС‚РІРµСЂРґРёС‚, РЅР°С‡РЅРµРј РіРѕС‚РѕРІРёС‚СЊ.",
    paid: "вњ… РћРїР»Р°С‚Р° РїРѕРґС‚РІРµСЂР¶РґРµРЅР°, Р·Р°РєР°Р· РїСЂРёРЅСЏС‚. Р“РѕС‚РѕРІРёРј! рџЌі",
    delivery: "рџ›µ Р’Р°С€ Р·Р°РєР°Р· РїРµСЂРµРґР°РЅ РєСѓСЂСЊРµСЂСѓ Рё СѓР¶Рµ РІ РїСѓС‚Рё.",
    completed: "рџЋ‰ Р—Р°РєР°Р· СѓСЃРїРµС€РЅРѕ РґРѕСЃС‚Р°РІР»РµРЅ, РїСЂРёСЏС‚РЅРѕРіРѕ Р°РїРїРµС‚РёС‚Р°!",
    pickup_ready: "вњ… Р’Р°С€ Р·Р°РєР°Р· РіРѕС‚РѕРІ! РњРѕР¶РµС‚Рµ Р·Р°Р±РёСЂР°С‚СЊ.",
    cancelled: "вќЊ Р’Р°С€ Р·Р°РєР°Р· РѕС‚РјРµРЅРµРЅ. РџСЂРё РЅРµРѕР±С…РѕРґРёРјРѕСЃС‚Рё РІС‹ РјРѕР¶РµС‚Рµ РѕС„РѕСЂРјРёС‚СЊ РЅРѕРІС‹Р№ Р·Р°РєР°Р· С‡РµСЂРµР· РјРµРЅСЋ.",
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
  await notifyDeveloperSystemFailure(instance, error, { scope: "kanban-webhook", ...meta }).catch(() => undefined);
}

async function notifyComplaint(body: Record<string, unknown>, config: Record<string, unknown>, instance: string) {
  const adminPhone = getAdminPhone(config);
  if (!adminPhone) return false;
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

  await sendWhatsProMessage({ instanceId: instance, phone: adminPhone, text: message });
  return true;
}

async function emitPrintOnPaid(req: Request, body: Record<string, unknown>, status: string) {
  if (status !== "paid") return;
  const io = req.app.get("io");
  if (io && typeof io.emit === "function") {
    io.emit("print_new_order", body);
  }
}

async function emitPrintOnNewOrder(req: Request, body: Record<string, unknown>, action: string) {
  if (action !== "new_order") return;
  const io = req.app.get("io");
  if (io && typeof io.emit === "function") {
    io.emit("print_new_order", body);
  }
}

async function sendAndRemember(instance: string, phone: string, text: string): Promise<void> {
  await sendWhatsProMessage({ instanceId: instance, phone, text });
  await saveToHistory(instance, phone, "model", `<bot_notification>\n${text}\n</bot_notification>`);
}

export async function handleKanbanWebhook(req: Request, res: Response): Promise<void> {
  const body = (req.body || {}) as Record<string, unknown>;
  const instance = cleanInline(body.instance || body.instanceId || body.restaurant_id, 80);
  const action = cleanInline(body.action, 80);
  let lockKey = "";
  let lockAcquired = false;

  try {
    if (!INSTANCE_RE.test(instance)) {
      res.status(400).json({ ok: false, error: "BAD_INSTANCE" });
      return;
    }
    if (!VALID_ACTIONS.has(action)) {
      res.status(400).json({ ok: false, error: "BAD_ACTION" });
      return;
    }

    if (action === "update_kitchen_status") {
      const status = await saveKitchenStatus(instance, body);
      res.status(200).json({ success: true, status });
      return;
    }

    if (action === "get_kitchen_status") {
      const status = await getKitchenStatus(instance);
      res.status(200).json({ success: true, status });
      return;
    }

    const config = (await getRestaurantConfig(instance)) || {};

    if (action === "developer_alert") {
      const message = cleanInline(body.error || body.message || body.reason || "developer_alert", 600);
      await notifyDeveloper(instance, new Error(message), { source: "developer_alert", orderId: body.order_id });
      res.status(200).json({ success: true, message: "Developer notified" });
      return;
    }

    if (action === "complaint") {
      const sent = await notifyComplaint(body, config, instance);
      res.status(200).json({ success: true, admin_notified: sent });
      return;
    }

    const isShiftNoteAction = action.startsWith("shift_note_");
    const phone = normalizePhone(body.phone || "");
    const orderId = cleanInline(body.order_id || "0", 40);
    const newStatus = cleanInline(body.status || body.new_status || body.order_status, 80);
    const isPickup = boolValue(body.is_pickup, false);

    if (!isShiftNoteAction) {
      if (!ORDER_ID_RE.test(orderId) || orderId === "0") {
        res.status(400).json({ ok: false, error: "BAD_ORDER_ID" });
        return;
      }
      if (!phone) {
        res.status(400).json({ ok: false, error: "BAD_PHONE" });
        return;
      }
    }

    await connectRedis();
    const shiftNotePayload = isShiftNoteAction ? extractShiftNotePayload(body) : null;
    const lockId = shiftNotePayload?.stableLockId || orderId;
    const lockScope = action === "status_changed" ? `${action}:${newStatus || "unknown"}` : action;
    lockKey = `kanban_lock:${instance}:${lockId}:${lockScope}`;
    const locked = await redisClient.set(lockKey, "1", { NX: true, EX: isShiftNoteAction ? 5 : 86400 });
    if (!locked) {
      res.status(200).json({ success: true, message: "Ignored duplicate signal" });
      return;
    }
    lockAcquired = true;

    if (action === "shift_note_created" && shiftNotePayload) {
      const saved = await saveShiftNote(instance, shiftNotePayload.noteId, shiftNotePayload.text, shiftNotePayload.expiresAt);
      if (!saved) throw new Error("SHIFT_NOTE_SAVE_FAILED");
      res.status(200).json({ success: true, message: "Note saved to AI memory" });
      return;
    }

    if (action === "shift_note_deleted" && shiftNotePayload) {
      await deleteShiftNote(instance, shiftNotePayload.noteId, shiftNotePayload.text);
      res.status(200).json({ success: true, message: "Note removed from AI memory" });
      return;
    }

    await emitPrintOnNewOrder(req, body, action);
    await emitPrintOnPaid(req, body, newStatus);

    const lang = getLanguage(body);
    let textMessage = "";
    if (action === "new_order") textMessage = buildLegacyNewOrderMessage(body, lang, orderId, isPickup);
    if (action === "request_payment") textMessage = await buildLegacyPaymentMessage(body, config, lang, instance);
    if (action === "order_rejected") textMessage = buildLegacyRejectedMessage(body, lang);
    if (action === "status_changed") {
      const effectiveStatus = newStatus === "completed" && isPickup ? "pickup_ready" : newStatus;
      textMessage = legacyStatusTemplates[lang][effectiveStatus] || "";
      if (!textMessage) {
        res.status(200).json({ success: true, message: "Ignored status not intended for client" });
        return;
      }
    }

    if (textMessage) {
      await sendAndRemember(instance, phone, textMessage);
      if (newStatus === "completed" || newStatus === "cancelled" || action === "order_rejected") {
        await redisClient.del([`history:${instance}:${phone}`, `last_order:${instance}:${phone}`]).catch(() => undefined);
      }
    }

    res.status(200).json({ success: true, message: "Processed" });
  } catch (error) {
    if (lockAcquired && lockKey) {
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

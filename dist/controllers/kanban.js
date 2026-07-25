import crypto from "node:crypto";
import { getRuntimeStatus, normalizePhone } from "../services/dle.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import {
  connectRedis,
  clearKitchenCheckoutState,
  deleteShiftNote,
  getKitchenStatus,
  getSiteLanguageHint,
  getUserLang,
  redisClient,
  saveKitchenStatus,
  saveSiteLanguageHint,
  saveShiftNote,
  saveToHistory
} from "../services/redis.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { auditDecision, auditError, auditOutbound, auditProcessing } from "../services/auditLogger.service.js";
import { normalizeSiteLanguage, resolveSiteOutboundLanguage } from "../services/languagePolicy.service.js";
const INSTANCE_RE = /^[a-zA-Z0-9_-]{2,64}$/;
const ORDER_ID_RE = /^\d{1,12}$/;
const VALID_ACTIONS = /* @__PURE__ */ new Set([
  "new_order",
  "status_changed",
  "request_payment",
  "order_rejected",
  "shift_note_created",
  "shift_note_deleted",
  "update_kitchen_status",
  "get_kitchen_status",
  "developer_alert",
  "complaint"
]);
const statusTemplates = {
  kk: {
    review: "\u0427\u0435\u043A \u0442\u0435\u043A\u0441\u0435\u0440\u0456\u043B\u0443\u0434\u0435. \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0440\u0430\u0441\u0442\u0430\u0493\u0430\u043D \u0441\u043E\u04A3 \u0434\u0430\u0439\u044B\u043D\u0434\u0430\u0439\u043C\u044B\u0437.",
    paid: "\u0422\u04E9\u043B\u0435\u043C \u0440\u0430\u0441\u0442\u0430\u043B\u0434\u044B, \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043D\u0434\u044B. \u0414\u0430\u0439\u044B\u043D\u0434\u0430\u043B\u044B\u043F \u0436\u0430\u0442\u044B\u0440.",
    delivery: "\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u043A\u0443\u0440\u044C\u0435\u0440\u0433\u0435 \u0431\u0435\u0440\u0456\u043B\u0434\u0456, \u0436\u0435\u0442\u043A\u0456\u0437\u0443 \u0436\u043E\u043B\u044B\u043D\u0434\u0430.",
    completed: "\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0441\u04D9\u0442\u0442\u0456 \u0430\u044F\u049B\u0442\u0430\u043B\u0434\u044B, \u0430\u0441\u044B\u04A3\u044B\u0437 \u0434\u04D9\u043C\u0434\u0456 \u0431\u043E\u043B\u0441\u044B\u043D!",
    pickup_ready: "\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u0434\u0430\u0439\u044B\u043D. \u041A\u0435\u043B\u0456\u043F \u0430\u043B\u044B\u043F \u043A\u0435\u0442\u0443\u0456\u04A3\u0456\u0437\u0433\u0435 \u0431\u043E\u043B\u0430\u0434\u044B.",
    cancelled: "\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437\u0434\u0430\u043D \u0431\u0430\u0441 \u0442\u0430\u0440\u0442\u044B\u043B\u0434\u044B. \u049A\u0430\u0436\u0435\u0442 \u0431\u043E\u043B\u0441\u0430, \u043C\u04D9\u0437\u0456\u0440 \u0430\u0440\u049B\u044B\u043B\u044B \u0436\u0430\u04A3\u0430 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0431\u0435\u0440\u0435 \u0430\u043B\u0430\u0441\u044B\u0437."
  },
  ru: {
    review: "\u0427\u0435\u043A \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442\u0441\u044F. \u041A\u0430\u043A \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442, \u043D\u0430\u0447\u043D\u0435\u043C \u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C.",
    paid: "\u041E\u043F\u043B\u0430\u0442\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430, \u0437\u0430\u043A\u0430\u0437 \u043F\u0440\u0438\u043D\u044F\u0442. \u0413\u043E\u0442\u043E\u0432\u0438\u043C.",
    delivery: "\u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u043F\u0435\u0440\u0435\u0434\u0430\u043D \u043A\u0443\u0440\u044C\u0435\u0440\u0443 \u0438 \u0443\u0436\u0435 \u0432 \u043F\u0443\u0442\u0438.",
    completed: "\u0417\u0430\u043A\u0430\u0437 \u0443\u0441\u043F\u0435\u0448\u043D\u043E \u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043D, \u043F\u0440\u0438\u044F\u0442\u043D\u043E\u0433\u043E \u0430\u043F\u043F\u0435\u0442\u0438\u0442\u0430!",
    pickup_ready: "\u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u0433\u043E\u0442\u043E\u0432. \u041C\u043E\u0436\u0435\u0442\u0435 \u0437\u0430\u0431\u0438\u0440\u0430\u0442\u044C.",
    cancelled: "\u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u043E\u0442\u043C\u0435\u043D\u0435\u043D. \u041F\u0440\u0438 \u043D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u043E\u0441\u0442\u0438 \u043C\u043E\u0436\u0435\u0442\u0435 \u043E\u0444\u043E\u0440\u043C\u0438\u0442\u044C \u043D\u043E\u0432\u044B\u0439 \u0437\u0430\u043A\u0430\u0437 \u0447\u0435\u0440\u0435\u0437 \u043C\u0435\u043D\u044E."
  }
};
function textValue(value, fallback = "") {
  return String(value ?? fallback).trim();
}
function cleanInline(value, max = 200) {
  return textValue(value).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").slice(0, max).trim();
}
function cleanCommentPrefix(value) {
  const s = cleanInline(value, 220);
  const regex = /(комментарий|коммент|пожелание|примечание|пікір|ескерту|түсініктеме)\s*[:\-]?\s*/giu;
  return s.replace(regex, "").trim();
}
function numberValue(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}
function boolValue(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = textValue(value).toLowerCase();
  if (["1", "true", "yes", "on", "pickup"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}
function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function normalizePaymentDetails(value) {
  return parseJsonArray(value).map((item) => {
    const source = item && typeof item === "object" ? item : {};
    return {
      label: cleanInline(source.label || source.name || source.title || "\u0420\u0435\u043A\u0432\u0438\u0437\u0438\u0442", 60),
      value: cleanInline(source.value || source.number || source.url || source.link || "", 250),
      source: source.source ? cleanInline(source.source, 40) : void 0
    };
  }).filter((item) => item.value).slice(0, 12);
}
function paymentDetailsText(details, lang) {
  if (!details.length) {
    return lang === "ru" ? "\u0420\u0435\u043A\u0432\u0438\u0437\u0438\u0442\u044B \u043F\u043E\u043A\u0430 \u043D\u0435 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u044B. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u043E\u0442\u0432\u0435\u0442 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430." : "\u0420\u0435\u043A\u0432\u0438\u0437\u0438\u0442\u0442\u0435\u0440 \u04D9\u0437\u0456\u0440\u0433\u0435 \u0431\u0430\u043F\u0442\u0430\u043B\u043C\u0430\u0493\u0430\u043D. \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0436\u0430\u0443\u0430\u0431\u044B\u043D \u043A\u04AF\u0442\u0435 \u0442\u04B1\u0440\u044B\u04A3\u044B\u0437.";
  }
  return details.map((item) => `${item.label}: ${item.value}`).join("\n");
}
function paymentDetailsFromRuntime(runtimeStatus) {
  if (!runtimeStatus) return [];
  const kitchen = runtimeStatus.kitchen_status && typeof runtimeStatus.kitchen_status === "object" ? runtimeStatus.kitchen_status : {};
  return normalizePaymentDetails(runtimeStatus.payment_details || kitchen.payment_details);
}
async function getLiveRuntimeStatus(instance, config) {
  const domain = textValue(config.domain || config.website || config.url);
  if (!domain) return null;
  return getRuntimeStatus(instance, domain, { forceFresh: true }).catch((error) => {
    auditError("Runtime status read failed", error, { instance, domain });
    return null;
  });
}
function getLanguage(body) {
  return textValue(body.lang || body.language).toLowerCase() === "ru" ? "ru" : "kk";
}
function normalizeItems(value) {
  return parseJsonArray(value).map((item) => {
    const source = item && typeof item === "object" ? item : {};
    const qty = Math.min(99, Math.max(1, numberValue(source.qty || source.count || source.quantity, 1)));
    const price = Math.max(0, numberValue(source.price, 0));
    return {
      name: cleanInline(source.name || source.title || source.product_name || "\u0422\u0430\u0443\u0430\u0440", 80),
      qty,
      price,
      total: Math.max(0, numberValue(source.total || source.sum, price * qty))
    };
  }).filter((item) => item.name).slice(0, 50);
}
function buildCartText(body) {
  const items = normalizeItems(body.items || body.goods || body.products);
  if (items.length) {
    return items.map((item) => `- ${item.name} x${item.qty} = ${item.total || item.price * item.qty} \u20B8`).join("\n");
  }
  const cartList = cleanInline(body.cart_list, 3e3);
  return cartList || "- \u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0442\u0456\u0437\u0456\u043C\u0456 \u0442\u0430\u0431\u044B\u043B\u043C\u0430\u0434\u044B";
}
function buildNewOrderMessage(body, lang, orderId, isPickup) {
  const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
  const address = cleanInline(body.address || (lang === "ru" ? "\u041D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D" : "\u041A\u04E9\u0440\u0441\u0435\u0442\u0456\u043B\u043C\u0435\u0433\u0435\u043D"), 200);
  const rawComment = cleanInline(body.comment || body.info, 500);
  const persons = numberValue(body.persons, 0);
  const bonus = numberValue(body.bonus, 0);
  const lines = lang === "ru" ? [`\u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u2116${orderId} \u043F\u0440\u0438\u043D\u044F\u0442!`, isPickup ? "\u0422\u0438\u043F: \u0441\u0430\u043C\u043E\u0432\u044B\u0432\u043E\u0437" : `\u0410\u0434\u0440\u0435\u0441: ${address}`] : [`\u2116${orderId} \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043D\u0434\u044B!`, isPickup ? "\u0422\u04AF\u0440\u0456: \u0430\u043B\u044B\u043F \u043A\u0435\u0442\u0443" : `\u041C\u0435\u043A\u0435\u043D\u0436\u0430\u0439: ${address}`];
  if (bonus > 0) lines.push(lang === "ru" ? `\u0421\u043F\u0438\u0441\u0430\u043D\u043D\u044B\u0439 \u0431\u043E\u043D\u0443\u0441: ${bonus} \u20B8` : `\u0416\u04B1\u043C\u0441\u0430\u043B\u0493\u0430\u043D \u0431\u043E\u043D\u0443\u0441: ${bonus} \u20B8`);
  if (persons > 0) lines.push(lang === "ru" ? `\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043F\u0435\u0440\u0441\u043E\u043D: ${persons}` : `\u0410\u0434\u0430\u043C \u0441\u0430\u043D\u044B: ${persons}`);
  if (rawComment) lines.push(lang === "ru" ? `\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439: ${rawComment}` : `\u041F\u0456\u043A\u0456\u0440: ${rawComment}`);
  lines.push("", lang === "ru" ? "\u0421\u043E\u0441\u0442\u0430\u0432 \u0437\u0430\u043A\u0430\u0437\u0430:" : "\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u049B\u04B1\u0440\u0430\u043C\u044B:", buildCartText(body));
  lines.push("", lang === "ru" ? `\u0418\u0442\u043E\u0433\u043E: ${totalAmount} \u20B8` : `\u0411\u0430\u0440\u043B\u044B\u0493\u044B: ${totalAmount} \u20B8`);
  lines.push(
    lang === "ru" ? "\u041C\u044B \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C \u043D\u0430\u043B\u0438\u0447\u0438\u0435 \u043D\u0430 \u043A\u0443\u0445\u043D\u0435, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043E\u0436\u0438\u0434\u0430\u0439\u0442\u0435 1-2 \u043C\u0438\u043D\u0443\u0442\u044B." : "\u0411\u0456\u0437 \u0430\u0441 \u04AF\u0439\u0434\u0435 \u0431\u0430\u0440-\u0436\u043E\u0493\u044B\u043D \u0442\u0435\u043A\u0441\u0435\u0440\u0456\u043F \u0436\u0430\u0442\u044B\u0440\u043C\u044B\u0437, 1-2 \u043C\u0438\u043D\u0443\u0442 \u043A\u04AF\u0442\u0435 \u0442\u04B1\u0440\u044B\u04A3\u044B\u0437."
  );
  return lines.join("\n");
}
async function buildPaymentMessage(body, config, lang, instance) {
  const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
  const runtimeStatus = await getLiveRuntimeStatus(instance, config);
  const runtimeDetails = paymentDetailsFromRuntime(runtimeStatus);
  const paymentInfo = paymentDetailsText(runtimeDetails, lang);
  if (lang === "ru") {
    return `\u0412\u0441\u0435 \u0432 \u043D\u0430\u043B\u0438\u0447\u0438\u0438!
\u0421\u0443\u043C\u043C\u0430 \u043A \u043E\u043F\u043B\u0430\u0442\u0435: ${totalAmount} \u20B8

\u041E\u043F\u043B\u0430\u0442\u0430:
${paymentInfo}

\u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0447\u0435\u043A \u043E\u0431 \u043E\u043F\u043B\u0430\u0442\u0435 \u0432 \u044D\u0442\u043E\u0442 \u0447\u0430\u0442.`;
  }
  return `\u0411\u04D9\u0440\u0456 \u0431\u0430\u0440!
\u0422\u04E9\u043B\u0435\u043C \u0441\u043E\u043C\u0430\u0441\u044B: ${totalAmount} \u20B8

\u0422\u04E9\u043B\u0435\u043C \u0436\u0430\u0441\u0430\u0443:
${paymentInfo}

\u0422\u04E9\u043B\u0435\u043C \u0436\u0430\u0441\u0430\u0493\u0430\u043D\u043D\u0430\u043D \u043A\u0435\u0439\u0456\u043D \u0447\u0435\u043A\u0442\u0456 \u043E\u0441\u044B \u0447\u0430\u0442\u049B\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.`;
}
function buildRejectedMessage(body, lang) {
  const reason = cleanInline(body.reason || (lang === "ru" ? "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u0440\u0438\u0447\u0438\u043D\u0430" : "\u0411\u0435\u043B\u0433\u0456\u0441\u0456\u0437 \u0441\u0435\u0431\u0435\u043F"), 200);
  return lang === "ru" ? `\u041A \u0441\u043E\u0436\u0430\u043B\u0435\u043D\u0438\u044E, \u043C\u044B \u043D\u0435 \u0441\u043C\u043E\u0436\u0435\u043C \u043F\u0440\u0438\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u0437\u0430\u043A\u0430\u0437.
\u041F\u0440\u0438\u0447\u0438\u043D\u0430: ${reason}.
\u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0435 \u0431\u043B\u044E\u0434\u043E.` : `\u04E8\u043A\u0456\u043D\u0456\u0448\u043A\u0435 \u049B\u0430\u0440\u0430\u0439, \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u0442\u044B \u0434\u0430\u0439\u044B\u043D\u0434\u0430\u0439 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u0437.
\u0421\u0435\u0431\u0435\u0431\u0456: ${reason}.
\u0411\u0430\u0441\u049B\u0430 \u0442\u0430\u0493\u0430\u043C \u0442\u0430\u04A3\u0434\u0430\u0443\u044B\u04A3\u044B\u0437\u0434\u044B \u0441\u04B1\u0440\u0430\u0439\u043C\u044B\u0437.`;
}
function paymentDetailsFromRuntimeOnly(runtimeStatus) {
  return paymentDetailsFromRuntime(runtimeStatus);
}
function paymentDetailsRuntimeSource(runtimeStatus) {
  return paymentDetailsFromRuntime(runtimeStatus).length ? "site_kitchen_settings" : "not_configured";
}
function buildLegacyNewOrderMessage(body, lang, orderId, isPickup) {
  let rawComment = String(body.comment || body.info || "");
  let extractedBonus = 0;
  let extractedPersons = 0;
  const deliveryMatch = rawComment.match(/\[(?:Доставка|Жеткізу)\s*:?[\s]*(\d+(?:[.,]\d+)?)\s*(?:т|₸)?\]/iu);
  const explicitDelivery = body.delivery_fee ?? body.delivery_price ?? body.delivery_cost ?? body.shipping_cost ?? body.delivery_amount;
  const deliveryFee = Math.max(
    0,
    numberValue(explicitDelivery ?? deliveryMatch?.[1]?.replace(",", ".") ?? 0, 0)
  );
  if (deliveryMatch) rawComment = rawComment.replace(deliveryMatch[0], "");
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
  let items = body.items || body.goods || body.products || [];
  if (typeof items === "string") {
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }
  if (Array.isArray(items) && items.length > 0) {
    cartText = items.slice(0, 50).map((item) => {
      const name = cleanInline(item?.name || item?.title || (lang === "ru" ? "\u0422\u043E\u0432\u0430\u0440" : "\u0422\u0430\u0443\u0430\u0440"), 80);
      const qty = Math.min(99, Math.max(1, Number(item?.qty || item?.count || item?.quantity || 1)));
      const price = Math.max(0, Number(item?.price || 0));
      const total = Math.max(0, Number(item?.total || item?.sum || price * qty));
      return `\u25AA\uFE0F ${name} x${qty} = ${total} \u20B8`;
    }).join("\n");
  } else if (typeof body.cart_list === "string" && body.cart_list.length > 2) {
    cartText = body.cart_list.slice(0, 3e3);
  } else {
    cartText = lang === "ru" ? "\u25AA\uFE0F (\u0421\u043E\u0441\u0442\u0430\u0432 \u0437\u0430\u043A\u0430\u0437\u0430 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D)" : "\u25AA\uFE0F (\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0442\u0456\u0437\u0456\u043C\u0456 \u0442\u0430\u0431\u044B\u043B\u043C\u0430\u0434\u044B)";
  }
  let textMessage = "";
  if (lang === "ru") {
    textMessage = `\u{1F6CD} *\u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u2116${orderId} \u043F\u0440\u0438\u043D\u044F\u0442!*
`;
    if (isPickup) textMessage += "\u{1F3C3} *\u0422\u0438\u043F:* \u0421\u0430\u043C\u043E\u0432\u044B\u0432\u043E\u0437\n";
    else textMessage += `\u{1F4CD} *\u0410\u0434\u0440\u0435\u0441:* ${cleanInline(body.address || "\u041D\u0435 \u0443\u043A\u0430\u0437\u0430\u043D", 200)}
`;
    if (bonusNum > 0) textMessage += `\u{1F381} *\u041F\u043E\u0442\u0440\u0430\u0447\u0435\u043D\u043D\u044B\u0439 \u0431\u043E\u043D\u0443\u0441:* ${bonusNum} \u20B8
`;
    if (persons > 0) textMessage += `\u{1F374} *\u041A\u043E\u043B\u0438\u0447\u0435\u0441\u0442\u0432\u043E \u043F\u0435\u0440\u0441\u043E\u043D:* ${persons}
`;
    if (comment) textMessage += `\u{1F4AC} *\u041A\u043E\u043C\u043C\u0435\u043D\u0442\u0430\u0440\u0438\u0439:* ${comment}
`;
    if (!isPickup) textMessage += `\u{1F69A} *\u0414\u043E\u0441\u0442\u0430\u0432\u043A\u0430:* ${deliveryFee > 0 ? `${deliveryFee} \u20B8` : "\u0411\u0435\u0441\u043F\u043B\u0430\u0442\u043D\u043E"}
`;
    textMessage += `
\u{1F6D2} *\u0421\u043E\u0441\u0442\u0430\u0432 \u0437\u0430\u043A\u0430\u0437\u0430:*
${cartText}
`;
    textMessage += `\u2796\u2796\u2796\u2796\u2796\u2796\u2796
\u{1F4B0} *\u0418\u0422\u041E\u0413\u041E: ${totalAmount} \u20B8*
\u2796\u2796\u2796\u2796\u2796\u2796\u2796

`;
    textMessage += "\u23F3 *\u0412\u043D\u0438\u043C\u0430\u043D\u0438\u0435:* \u041C\u044B \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u043C \u043D\u0430\u043B\u0438\u0447\u0438\u0435 \u043D\u0430 \u043A\u0443\u0445\u043D\u0435, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043E\u0436\u0438\u0434\u0430\u0439\u0442\u0435 1-2 \u043C\u0438\u043D\u0443\u0442\u044B...";
  } else {
    textMessage = `\u{1F6CD} *\u2116${orderId} \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043D\u0434\u044B!*
`;
    if (isPickup) textMessage += "\u{1F3C3} *\u0422\u04AF\u0440\u0456:* \u0410\u043B\u044B\u043F \u043A\u0435\u0442\u0443 (\u0421\u0430\u043C\u043E\u0432\u044B\u0432\u043E\u0437)\n";
    else textMessage += `\u{1F4CD} *\u041C\u0435\u043A\u0435\u043D\u0436\u0430\u0439:* ${cleanInline(body.address || "\u041A\u04E9\u0440\u0441\u0435\u0442\u0456\u043B\u043C\u0435\u0433\u0435\u043D", 200)}
`;
    if (bonusNum > 0) textMessage += `\u{1F381} *\u0416\u04B1\u043C\u0441\u0430\u043B\u0493\u0430\u043D \u0431\u043E\u043D\u0443\u0441:* ${bonusNum} \u20B8
`;
    if (persons > 0) textMessage += `\u{1F374} *\u0410\u0434\u0430\u043C \u0441\u0430\u043D\u044B:* ${persons}
`;
    if (comment) textMessage += `\u{1F4AC} *\u041F\u0456\u043A\u0456\u0440:* ${comment}
`;
    if (!isPickup) textMessage += `\u{1F69A} *\u0416\u0435\u0442\u043A\u0456\u0437\u0443:* ${deliveryFee > 0 ? `${deliveryFee} \u20B8` : "\u0422\u0435\u0433\u0456\u043D"}
`;
    textMessage += `
\u{1F6D2} *\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u049B\u04B1\u0440\u0430\u043C\u044B:*
${cartText}
`;
    textMessage += `\u2796\u2796\u2796\u2796\u2796\u2796\u2796
\u{1F4B0} *\u0411\u0410\u0420\u041B\u042B\u0492\u042B: ${totalAmount} \u20B8*
\u2796\u2796\u2796\u2796\u2796\u2796\u2796

`;
    textMessage += "\u23F3 *\u041D\u0430\u0437\u0430\u0440\u044B\u04A3\u044B\u0437\u0493\u0430:* \u0411\u0456\u0437 \u0430\u0441 \u04AF\u0439\u0434\u0435 \u0431\u0430\u0440-\u0436\u043E\u0493\u044B\u043D \u0442\u0435\u043A\u0441\u0435\u0440\u0456\u043F \u0436\u0430\u0442\u044B\u0440\u043C\u044B\u0437, 1-2 \u043C\u0438\u043D\u0443\u0442 \u043A\u04AF\u0442\u0435 \u0442\u04B1\u0440\u044B\u04A3\u044B\u0437...";
  }
  return textMessage;
}
async function buildLegacyPaymentMessage(body, config, lang, instance) {
  const totalAmount = cleanInline(body.total_price || body.total || 0, 40);
  const liveRuntimeStatus = await getLiveRuntimeStatus(instance, config || {});
  const paymentDetails = paymentDetailsFromRuntimeOnly(liveRuntimeStatus);
  const paymentInfo = paymentDetailsText(paymentDetails, lang);
  auditDecision("Payment details resolved", {
    instance,
    source: paymentDetailsRuntimeSource(liveRuntimeStatus),
    count: paymentDetails.length
  });
  return formatLegacyPaymentMessage(totalAmount, paymentInfo, lang);
}
function formatLegacyPaymentMessage(totalAmount, paymentInfo, lang) {
  if (lang === "ru") {
    return `\u2705 *\u0412\u0441\u0451 \u0432 \u043D\u0430\u043B\u0438\u0447\u0438\u0438!*
\u{1F4B0} \u0421\u0443\u043C\u043C\u0430 \u043A \u043E\u043F\u043B\u0430\u0442\u0435: *${totalAmount} \u20B8*

\u{1F4B3} *\u041E\u043F\u043B\u0430\u0442\u0430:*
${paymentInfo}

\u{1F9FE} *\u041F\u043E\u0441\u043B\u0435 \u043E\u043F\u043B\u0430\u0442\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0447\u0435\u043A \u0432 \u044D\u0442\u043E\u0442 \u0447\u0430\u0442 \u{1F447}*`;
  }
  return `\u2705 *\u0411\u04D9\u0440\u0456 \u0431\u0430\u0440!*
\u{1F4B0} \u0422\u04E9\u043B\u0435\u043C \u0441\u043E\u043C\u0430\u0441\u044B: *${totalAmount} \u20B8*

\u{1F4B3} *\u0422\u04E9\u043B\u0435\u043C \u0436\u0430\u0441\u0430\u0443:*
${paymentInfo}

\u{1F9FE} *\u0422\u04E9\u043B\u0435\u043C \u0436\u0430\u0441\u0430\u0493\u0430\u043D\u043D\u0430\u043D \u043A\u0435\u0439\u0456\u043D \u0447\u0435\u043A\u0442\u0456 \u043E\u0441\u044B \u0447\u0430\u0442\u049B\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437 \u{1F447}*`;
}
function buildLegacyRejectedMessage(body, lang) {
  const reason = cleanInline(body.reason || (lang === "ru" ? "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u0440\u0438\u0447\u0438\u043D\u0430" : "\u0411\u0435\u043B\u0433\u0456\u0441\u0456\u0437 \u0441\u0435\u0431\u0435\u043F"), 200);
  return lang === "ru" ? `\u274C \u041A \u0441\u043E\u0436\u0430\u043B\u0435\u043D\u0438\u044E, \u043C\u044B \u043D\u0435 \u0441\u043C\u043E\u0436\u0435\u043C \u043F\u0440\u0438\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u0437\u0430\u043A\u0430\u0437.
\u041F\u0440\u0438\u0447\u0438\u043D\u0430: *${reason}*.
\u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u0432\u044B\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u043E\u0435 \u0431\u043B\u044E\u0434\u043E.` : `\u274C \u04E8\u043A\u0456\u043D\u0456\u0448\u043A\u0435 \u049B\u0430\u0440\u0430\u0439, \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u0442\u044B \u0434\u0430\u0439\u044B\u043D\u0434\u0430\u0439 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u0437.
\u0421\u0435\u0431\u0435\u0431\u0456: *${reason}*.
\u0411\u0430\u0441\u049B\u0430 \u0442\u0430\u0493\u0430\u043C \u0442\u0430\u04A3\u0434\u0430\u0443\u044B\u04A3\u044B\u0437\u0434\u044B \u0441\u04B1\u0440\u0430\u0439\u043C\u044B\u0437.`;
}
const legacyStatusTemplates = {
  kk: {
    review: "\u23F3 \u0427\u0435\u043A \u0442\u0435\u043A\u0441\u0435\u0440\u0456\u043B\u0443\u0434\u0435. \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0440\u0430\u0441\u0442\u0430\u0493\u0430\u043D \u0441\u043E\u04A3 \u0434\u0430\u0439\u044B\u043D\u0434\u0430\u0439\u043C\u044B\u0437.",
    paid: "\u2705 \u0422\u04E9\u043B\u0435\u043C \u0440\u0430\u0441\u0442\u0430\u043B\u0434\u044B, \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043D\u0434\u044B. \u0414\u0430\u0439\u044B\u043D\u0434\u0430\u043B\u0443\u0434\u0430! \u{1F373}",
    delivery: "\u{1F6F5} \u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u043A\u0443\u0440\u044C\u0435\u0440\u0433\u0435 \u0431\u0435\u0440\u0456\u043B\u0434\u0456, \u0436\u0435\u0442\u043A\u0456\u0437\u0443 \u0436\u043E\u043B\u044B\u043D\u0434\u0430.",
    completed: "\u{1F389} \u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0441\u04D9\u0442\u0442\u0456 \u0430\u044F\u049B\u0442\u0430\u043B\u0434\u044B, \u0430\u0441\u044B\u04A3\u044B\u0437 \u0434\u04D9\u043C\u0434\u0456 \u0431\u043E\u043B\u0441\u044B\u043D!",
    pickup_ready: "\u2705 \u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437 \u0434\u0430\u0439\u044B\u043D! \u041A\u0435\u043B\u0456\u043F \u0430\u043B\u044B\u043F \u043A\u0435\u0442\u0443\u0456\u04A3\u0456\u0437\u0433\u0435 \u0431\u043E\u043B\u0430\u0434\u044B.",
    cancelled: "\u274C \u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u044B\u04A3\u044B\u0437\u0434\u0430\u043D \u0431\u0430\u0441 \u0442\u0430\u0440\u0442\u044B\u043B\u0434\u044B. \u049A\u0430\u0436\u0435\u0442 \u0431\u043E\u043B\u0441\u0430, \u043C\u04D9\u0437\u0456\u0440 \u0430\u0440\u049B\u044B\u043B\u044B \u0436\u0430\u04A3\u0430 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0431\u0435\u0440\u0435 \u0430\u043B\u0430\u0441\u044B\u0437."
  },
  ru: {
    review: "\u23F3 \u0427\u0435\u043A \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0435\u0442\u0441\u044F. \u041A\u0430\u043A \u0442\u043E\u043B\u044C\u043A\u043E \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442, \u043D\u0430\u0447\u043D\u0451\u043C \u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C.",
    paid: "\u2705 \u041E\u043F\u043B\u0430\u0442\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430, \u0437\u0430\u043A\u0430\u0437 \u043F\u0440\u0438\u043D\u044F\u0442. \u0413\u043E\u0442\u043E\u0432\u0438\u043C! \u{1F373}",
    delivery: "\u{1F6F5} \u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u043F\u0435\u0440\u0435\u0434\u0430\u043D \u043A\u0443\u0440\u044C\u0435\u0440\u0443 \u0438 \u0443\u0436\u0435 \u0432 \u043F\u0443\u0442\u0438.",
    completed: "\u{1F389} \u0417\u0430\u043A\u0430\u0437 \u0443\u0441\u043F\u0435\u0448\u043D\u043E \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D, \u043F\u0440\u0438\u044F\u0442\u043D\u043E\u0433\u043E \u0430\u043F\u043F\u0435\u0442\u0438\u0442\u0430!",
    pickup_ready: "\u2705 \u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u0433\u043E\u0442\u043E\u0432! \u041C\u043E\u0436\u0435\u0442\u0435 \u0437\u0430\u0431\u0438\u0440\u0430\u0442\u044C.",
    cancelled: "\u274C \u0412\u0430\u0448 \u0437\u0430\u043A\u0430\u0437 \u043E\u0442\u043C\u0435\u043D\u0451\u043D. \u041F\u0440\u0438 \u043D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u043E\u0441\u0442\u0438 \u043C\u043E\u0436\u0435\u0442\u0435 \u043E\u0444\u043E\u0440\u043C\u0438\u0442\u044C \u043D\u043E\u0432\u044B\u0439 \u0437\u0430\u043A\u0430\u0437 \u0447\u0435\u0440\u0435\u0437 \u043C\u0435\u043D\u044E."
  }
};
function extractShiftNotePayload(body) {
  const noteId = cleanInline(body.note_id || body.noteId || body.id, 80);
  const text = textValue(body.text || body.note_text || body.note || body.message);
  const expiresAt = cleanInline(body.expires_at || body.expiresAt || body.expires || body.until, 80);
  const shiftKey = cleanInline(body.shift_key || body.shiftKey, 80);
  const stableLockId = noteId && noteId !== "0" ? noteId : `fallback_${crypto.createHash("sha1").update(`${body.action || ""}|${shiftKey}|${text}|${expiresAt}`).digest("hex").slice(0, 16)}`;
  return { noteId, text, expiresAt, shiftKey, stableLockId };
}
function getDeveloperPhone(config) {
  return normalizePhone(config.dev_phone || "");
}
function getAdminPhone(config) {
  return normalizePhone(config.admin_phone || "");
}
async function notifyDeveloper(instance, error, meta) {
  await notifyDeveloperSystemFailure(instance, error, { scope: "kanban_webhook", ...meta }).catch(() => void 0);
}
async function notifyComplaint(body, config, instance) {
  const adminPhone = getAdminPhone(config);
  if (!adminPhone) {
    auditDecision("Complaint notification skipped: admin phone missing", { instance });
    return false;
  }
  const phone = normalizePhone(body.phone || body.customer_phone || "");
  const orderId = cleanInline(body.order_id || body.orderId || "\u0422\u0430\u0431\u044B\u043B\u043C\u0430\u0434\u044B", 40);
  const restaurant = cleanInline(config.name || config.restaurant_name || instance, 120);
  const summary = cleanInline(body.admin_summary || body.summary || body.reason || body.text || body.message, 600);
  const message = [
    "\u0416\u0410\u04A2\u0410 \u0428\u0410\u0492\u042B\u041C",
    `\u0420\u0435\u0441\u0442\u043E\u0440\u0430\u043D: ${restaurant}`,
    phone ? `\u041A\u043B\u0438\u0435\u043D\u0442: +${phone}` : "",
    `\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u2116: ${orderId}`,
    "",
    `AI \u0430\u043D\u0430\u043B\u0438\u0437\u0456: ${summary || "\u041A\u043B\u0438\u0435\u043D\u0442 \u0448\u0430\u0493\u044B\u043C \u049B\u0430\u043B\u0434\u044B\u0440\u0434\u044B."}`
  ].filter(Boolean).join("\n");
  auditOutbound("Triggering WhatsApp complaint notification", {
    instance,
    phone: adminPhone,
    text: message
  });
  await sendWhatsProMessage({ instanceId: instance, phone: adminPhone, text: message });
  return true;
}
async function emitPrintOnPaid(req, body, status) {
  if (status !== "paid") {
    auditDecision("Print trigger skipped: status is not paid", {
      orderId: body.order_id,
      status
    });
    return;
  }
  const io = req.app.get("io");
  if (io && typeof io.emit === "function") {
    auditDecision("Print trigger emitted for paid status", {
      orderId: body.order_id,
      status
    });
    io.emit("print_new_order", body);
  } else {
    auditDecision("Print trigger skipped: socket server unavailable", {
      orderId: body.order_id,
      status
    });
  }
}
async function emitPrintOnNewOrder(req, body, action) {
  if (action !== "new_order") {
    auditDecision("Print trigger skipped: action is not new_order", {
      orderId: body.order_id,
      action
    });
    return;
  }
  const io = req.app.get("io");
  if (io && typeof io.emit === "function") {
    auditDecision("Print trigger emitted for new order", {
      orderId: body.order_id,
      action
    });
    io.emit("print_new_order", body);
  } else {
    auditDecision("Print trigger skipped: socket server unavailable", {
      orderId: body.order_id,
      action
    });
  }
}
async function sendAndRemember(instance, phone, text) {
  auditOutbound("Triggering WhatsApp customer notification", {
    instance,
    phone,
    text
  });
  await sendWhatsProMessage({ instanceId: instance, phone, text });
  auditDecision("Saving bot notification to Redis history", {
    instance,
    phone,
    textLength: text.length
  });
  await saveToHistory(instance, phone, "model", `<bot_notification>
${text}
</bot_notification>`);
}
async function handleKanbanWebhook(req, res) {
  const body = req.body || {};
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
    event_time: body.event_time
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
        reset_at: body.reset_at || body.resetAt
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
    const config = await getRestaurantConfig(instance) || {};
    auditDecision("Restaurant config loaded", {
      instance,
      action,
      orderId: rawOrderId,
      hasDeveloperPhone: Boolean(getDeveloperPhone(config)),
      hasAdminPhone: Boolean(getAdminPhone(config))
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
    const lockedLanguage = await getUserLang(instance, phone).catch(() => null);
    const payloadLanguage = normalizeSiteLanguage(body.lang || body.language);
    let siteLanguageHint = await getSiteLanguageHint(instance, phone).catch(() => null);
    if (!lockedLanguage && action === "new_order" && payloadLanguage) {
      await saveSiteLanguageHint(instance, phone, payloadLanguage).catch(() => false);
      siteLanguageHint = payloadLanguage;
    }
    const lang = resolveSiteOutboundLanguage(lockedLanguage, payloadLanguage, siteLanguageHint);
    let textMessage = "";
    if (action === "new_order") {
      await clearKitchenCheckoutState(instance, phone).catch(() => void 0);
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
        textLength: textMessage.length
      });
      await sendAndRemember(instance, phone, textMessage);
      if (newStatus === "completed" || newStatus === "cancelled" || action === "order_rejected") {
        auditDecision("Cleaning completed/cancelled order Redis history", { orderId, action, instance, phone, newStatus });
        await redisClient.del([`history:${instance}:${phone}`, `last_order:${instance}:${phone}`]).catch(() => void 0);
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
      lockAcquired
    });
    if (lockAcquired && lockKey) {
      auditDecision("Releasing idempotency lock after failure", { orderId: body.order_id || rawOrderId, action, instance, lockKey });
      await redisClient.del(lockKey).catch(() => void 0);
    }
    await notifyDeveloper(instance, error, {
      orderId: body.order_id,
      action
    });
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : String(error || "kanban webhook failed")
      });
    }
  }
}
export {
  buildLegacyNewOrderMessage,
  buildLegacyRejectedMessage,
  formatLegacyPaymentMessage,
  handleKanbanWebhook,
  legacyStatusTemplates
};

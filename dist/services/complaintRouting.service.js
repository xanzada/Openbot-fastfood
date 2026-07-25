import crypto from "node:crypto";
import { clearComplaintMedia, getComplaintMedia } from "./redis.service.js";
import { getRestaurantConfig } from "./nocodb.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { createOperatorCase, detectOperatorCaseKind } from "./operatorCase.service.js";
import { sendOperatorSosSignal } from "./dle.service.js";
import { auditError } from "./auditLogger.service.js";
const ESCALATION_SIGNAL_RE = /\[(ESCALATE_ADMIN|ESCALATE_DEVELOPER)\]/giu;
const ADMIN_SIGNAL_RE = /\[ESCALATE_ADMIN\]/iu;
const DEVELOPER_SIGNAL_RE = /\[ESCALATE_DEVELOPER\]/iu;
const COMPLAINT_RE = /(шағым|жалоб|претензи|волос|шаш|гряз|лас|суық|суык|холодн|испорч|бұзыл|бузыл|улан|отрав|не тот заказ|басқа тапсырыс|қате тапсырыс|не привезли|жетпей|не хватает|сапа|качест)/iu;
function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}
function cleanLine(value, max = 700) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}
function getAdminPhone(config = {}) {
  return normalizePhone(
    config.admin_phone || config.admin || config.manager_phone || config.operator_phone || config.complaint_phone || process.env.ADMIN_PHONE || ""
  );
}
function getRestaurantLabel(ctx, liveConfig) {
  return cleanLine(liveConfig.name || liveConfig.restaurant_name || ctx.config?.name || ctx.config?.restaurant_name || ctx.instanceId, 120);
}
function getOrderLabel(ctx) {
  return cleanLine(ctx.activeOrder?.order_id || ctx.activeOrder?.id || ctx.activeOrder?.orderId || "not_found", 80);
}
function toWhatsProMedia(media) {
  if (!media?.base64) return null;
  const mimeType = media.mimeType || media.mediaType || "image/jpeg";
  return {
    base64: media.base64,
    mimeType,
    filename: media.filename,
    type: mimeType.startsWith("image/") ? "image" : "document"
  };
}
function hasEscalateAdminSignal(text = "") {
  return ADMIN_SIGNAL_RE.test(String(text || ""));
}
function hasEscalateDeveloperSignal(text = "") {
  return DEVELOPER_SIGNAL_RE.test(String(text || ""));
}
function stripEscalationSignals(text = "") {
  return String(text || "").replace(ESCALATION_SIGNAL_RE, "").replace(/\s{2,}/g, " ").trim();
}
function isLikelyComplaintText(text = "") {
  return COMPLAINT_RE.test(String(text || ""));
}
function isLikelyOperatorRequestText(text = "") {
  return Boolean(detectOperatorCaseKind(text));
}
function buildComplaintClarificationReply(language) {
  return language === "ru" ? "\u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043A\u043E\u0440\u043E\u0442\u043A\u043E \u043E\u043F\u0438\u0448\u0438\u0442\u0435 \u043F\u0440\u043E\u0431\u043B\u0435\u043C\u0443 \u0442\u0435\u043A\u0441\u0442\u043E\u043C. \u042F \u043F\u0435\u0440\u0435\u0434\u0430\u043C \u0444\u043E\u0442\u043E \u0438 \u043E\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443." : "\u041C\u04D9\u0441\u0435\u043B\u0435\u043D\u0456 \u049B\u044B\u0441\u049B\u0430\u0448\u0430 \u043C\u04D9\u0442\u0456\u043D\u043C\u0435\u043D \u0441\u0438\u043F\u0430\u0442\u0442\u0430\u043F \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437. \u0424\u043E\u0442\u043E \u043C\u0435\u043D \u0441\u0438\u043F\u0430\u0442\u0442\u0430\u043C\u0430\u043D\u044B \u0430\u0434\u043C\u0438\u043D\u0433\u0435 \u0436\u0456\u0431\u0435\u0440\u0435\u043C\u0456\u043D.";
}
function buildComplaintAckReply(language) {
  return language === "ru" ? "\u0418\u0437\u0432\u0438\u043D\u0438\u0442\u0435 \u0437\u0430 \u0441\u0438\u0442\u0443\u0430\u0446\u0438\u044E. \u042F \u043F\u0435\u0440\u0435\u0434\u0430\u043B \u0436\u0430\u043B\u043E\u0431\u0443 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443, \u043E\u043D \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442 \u0438 \u0441\u0432\u044F\u0436\u0435\u0442\u0441\u044F \u0441 \u0432\u0430\u043C\u0438." : "\u041A\u0435\u0448\u0456\u0440\u0456\u04A3\u0456\u0437. \u0428\u0430\u0493\u044B\u043C\u0434\u044B \u0430\u0434\u043C\u0438\u043D\u0433\u0435 \u0436\u0456\u0431\u0435\u0440\u0434\u0456\u043C, \u043E\u043B \u0442\u0435\u043A\u0441\u0435\u0440\u0456\u043F \u0441\u0456\u0437\u0431\u0435\u043D \u0431\u0430\u0439\u043B\u0430\u043D\u044B\u0441\u0430\u0434\u044B.";
}
async function hasPendingComplaintMedia(instanceId, phone) {
  const media = await getComplaintMedia(instanceId, phone).catch(() => null);
  return Boolean(media?.base64);
}
async function routeComplaintToAdmin(ctx, input) {
  const liveConfig = await getRestaurantConfig(ctx.instanceId).catch(() => null) || {};
  const adminPhone = getAdminPhone(liveConfig);
  const savedMedia = await getComplaintMedia(ctx.instanceId, ctx.phone).catch(() => null);
  const media = toWhatsProMedia(input.media || savedMedia);
  const summary = cleanLine(input.summary || input.customerText || ctx.text || "Customer complaint requires review.");
  const customerText = cleanLine(input.customerText || ctx.text || "", 900);
  const urgency = input.urgency || "normal";
  const detectedKind = detectOperatorCaseKind(input.customerText || ctx.text);
  const kind = input.source === "long_voice" ? "long_voice" : detectedKind || "complaint";
  const signalId = `sos_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  const domain = cleanLine(liveConfig.domain || ctx.config?.domain || "", 255);
  const [chatSignal, dleSignal] = await Promise.allSettled([
    createOperatorCase({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      kind,
      summary,
      source: input.source,
      urgency,
      orderNumber: getOrderLabel(ctx),
      hasMedia: Boolean(media),
      signalId
    }),
    domain ? sendOperatorSosSignal({ instanceId: ctx.instanceId, phone: ctx.phone, domain, signalId, kind, summary, urgency, source: input.source }) : Promise.reject(new Error("DLE_DOMAIN_NOT_CONFIGURED"))
  ]);
  const operatorCase = chatSignal.status === "fulfilled" ? chatSignal.value : null;
  const dleNotified = dleSignal.status === "fulfilled";
  if (chatSignal.status === "rejected") auditError("WhatsPro SOS signal failed", chatSignal.reason, { instanceId: ctx.instanceId, signalId, kind });
  if (dleSignal.status === "rejected") auditError("DLE operator SOS signal failed", dleSignal.reason, { instanceId: ctx.instanceId, signalId, kind });
  const adminText = [
    "OPENBOT COMPLAINT",
    `Restaurant: ${getRestaurantLabel(ctx, liveConfig)}`,
    `Customer: +${ctx.phone}`,
    `Order: ${getOrderLabel(ctx)}`,
    `Urgency: ${urgency}`,
    `Source: ${cleanLine(input.source || "openbot", 80)}`,
    "",
    `Summary: ${summary}`,
    customerText && customerText !== summary ? `Customer text: ${customerText}` : ""
  ].filter(Boolean).join("\n");
  let sent = null;
  if (adminPhone) {
    sent = await sendWhatsProMessage({ instanceId: ctx.instanceId, phone: adminPhone, text: adminText, media }).catch(() => null);
    if (savedMedia?.base64) {
      await clearComplaintMedia(ctx.instanceId, ctx.phone).catch(() => void 0);
    }
  }
  return {
    action: "operator_case_created",
    caseId: operatorCase?.id || null,
    queuedForChat: Boolean(operatorCase),
    escalationAvailable: Boolean(operatorCase || dleNotified || adminPhone),
    signaledToDle: dleNotified,
    signalId,
    mediaAttached: Boolean(media),
    sent: Boolean(sent?.acknowledged),
    customerReply: input.customerReply || buildComplaintAckReply(ctx.language)
  };
}
export {
  buildComplaintAckReply,
  buildComplaintClarificationReply,
  hasEscalateAdminSignal,
  hasEscalateDeveloperSignal,
  hasPendingComplaintMedia,
  isLikelyComplaintText,
  isLikelyOperatorRequestText,
  routeComplaintToAdmin,
  stripEscalationSignals
};

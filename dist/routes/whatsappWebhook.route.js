import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import {
  claimReceiptFingerprint,
  clearPendingKitchenConsent,
  getPendingKitchenConsent,
  hasActiveKitchenCheckout,
  releaseReceiptFingerprint,
  saveComplaintMedia,
  savePendingKitchenConsent,
  saveToHistory
} from "../services/redis.service.js";
import {
  buildComplaintAckReply,
  buildComplaintClarificationReply,
  hasEscalateAdminSignal,
  hasEscalateDeveloperSignal,
  hasPendingComplaintMedia,
  isLikelyComplaintText,
  isLikelyOperatorRequestText,
  routeComplaintToAdmin,
  stripEscalationSignals
} from "../services/complaintRouting.service.js";
import {
  bufferInboundText,
  claimMediaAiQuota,
  clearInboundProcessing,
  extractInboundMedia,
  extractSenderMeta,
  extractInboundText,
  extractMessageId,
  guardIncomingMessage,
  hydrateInboundMedia,
  markInboundDone,
  safeMediaMetadata,
  saveMediaContext,
  setOperatorAutoMute
} from "../services/inboundGuard.service.js";
import { syncKanbanEvent } from "../services/kanbanSync.service.js";
import { notifyAllDevelopersSystemFailure, notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { sendWhatsProResponseSequence, startWhatsProTyping } from "../transport/whatspro.client.js";
import { getPhoneCandidatesFromWebhook, normalizePhoneFromCandidates } from "../services/dle.service.js";
import { customerOrderFromRecord, formatCustomerOrderStatus, getCustomerOrder } from "../services/customerOrder.service.js";
import { deliverReceiptToClient } from "../services/receiptDelivery.service.js";
import { evaluateForShpor, getRestaurantConfig, getRestaurantConfigByWhatsAppPhone, saveToShpor } from "../services/nocodb.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import {
  analyzeMedia,
  createReceiptFingerprint,
  receiptFilterEnabled,
  validateReceiptAnalysis
} from "../services/mediaAnalysis.service.js";
import { getTextModels } from "../services/llm.service.js";
import { classifyKitchenSalesPolicy, detectKitchenConsentAnswer, detectRequestedServiceChannel } from "../services/kitchenPolicy.service.js";
import { isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp, requestedOrderNumber } from "../utils/orderIntent.js";
import { noteHistoryMeta } from "../services/noteProvenance.service.js";
import { bumpOperatorCaseSignal, detectOperatorCaseKind } from "../services/operatorCase.service.js";
const STATUS_CONTEXT_RE = /(асүй|ас үй|кухн|kitchen|повар|cook|статус|status|ашылды ма|жабық па|жұмыс істеп жатыр|работает|открыт|закрыт|готов|дайын)/iu;
function maskPhone(phone = "") {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length <= 6) return clean || "-";
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}
function rejectedReceiptReply(language, reason) {
  if (language === "ru") {
    if (reason === "amount_mismatch") return "\u0421\u0443\u043C\u043C\u0430 \u0432 \u0447\u0435\u043A\u0435 \u043D\u0435 \u0441\u043E\u0432\u043F\u0430\u0434\u0430\u0435\u0442 \u0441 \u0441\u0443\u043C\u043C\u043E\u0439 \u0437\u0430\u043A\u0430\u0437\u0430. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u044B\u0439 \u0447\u0435\u043A.";
    if (["receipt_too_old", "receipt_before_order"].includes(reason)) return "\u042D\u0442\u043E\u0442 \u0447\u0435\u043A \u0441\u0442\u0430\u0440\u044B\u0439 \u0438\u043B\u0438 \u0431\u044B\u043B \u0441\u043E\u0437\u0434\u0430\u043D \u0434\u043E \u0437\u0430\u043A\u0430\u0437\u0430. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043D\u043E\u0432\u044B\u0439 \u0447\u0435\u043A \u043F\u043E \u0442\u0435\u043A\u0443\u0449\u0435\u043C\u0443 \u0437\u0430\u043A\u0430\u0437\u0443.";
    return "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u044C \u043F\u043E\u0434\u043B\u0438\u043D\u043D\u043E\u0441\u0442\u044C \u0447\u0435\u043A\u0430. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u0441\u0432\u0435\u0436\u0438\u0439 \u043F\u043E\u043B\u043D\u044B\u0439 \u0447\u0435\u043A, \u0433\u0434\u0435 \u0432\u0438\u0434\u043D\u044B \u0438\u043C\u044F \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044F, \u0431\u0430\u043D\u043A, \u0441\u0443\u043C\u043C\u0430 \u0438 \u0434\u0430\u0442\u0430.";
  }
  if (reason === "amount_mismatch") return "\u0427\u0435\u043A\u0442\u0435\u0433\u0456 \u0441\u043E\u043C\u0430 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0441\u043E\u043C\u0430\u0441\u044B\u043D\u0430 \u0441\u04D9\u0439\u043A\u0435\u0441 \u0435\u043C\u0435\u0441. \u0414\u04B1\u0440\u044B\u0441 \u0447\u0435\u043A\u0442\u0456 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.";
  if (["receipt_too_old", "receipt_before_order"].includes(reason)) return "\u0411\u04B1\u043B \u0447\u0435\u043A \u0435\u0441\u043A\u0456 \u043D\u0435\u043C\u0435\u0441\u0435 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u0442\u0430\u043D \u0431\u04B1\u0440\u044B\u043D \u0436\u0430\u0441\u0430\u043B\u0493\u0430\u043D. \u041E\u0441\u044B \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u049B\u0430 \u0430\u0440\u043D\u0430\u043B\u0493\u0430\u043D \u0436\u0430\u04A3\u0430 \u0447\u0435\u043A\u0442\u0456 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.";
  return "\u0427\u0435\u043A\u0442\u0456\u04A3 \u0434\u04B1\u0440\u044B\u0441\u0442\u044B\u0493\u044B\u043D \u0440\u0430\u0441\u0442\u0430\u0439 \u0430\u043B\u043C\u0430\u0434\u044B\u043C. \u0416\u0456\u0431\u0435\u0440\u0443\u0448\u0456\u043D\u0456\u04A3 \u0430\u0442\u044B, \u0431\u0430\u043D\u043A, \u0441\u043E\u043C\u0430 \u0436\u04D9\u043D\u0435 \u043A\u04AF\u043D\u0456 \u0430\u043D\u044B\u049B \u043A\u04E9\u0440\u0456\u043D\u0435\u0442\u0456\u043D \u0442\u043E\u043B\u044B\u049B \u0436\u0430\u04A3\u0430 \u0447\u0435\u043A\u0442\u0456 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.";
}
function getInstanceId(body) {
  return String(
    body?.instance || body?.instanceId || body?.instance_id || body?.restaurant_id || body?.restaurant_instance || body?.restaurantInstance || body?.data?.instance || body?.data?.instanceId || body?.data?.instance_id || body?.data?.restaurant_id || ""
  ).trim();
}
function getPhone(body) {
  const eventData = body?.data || body || {};
  const key = eventData?.key || body?.key || {};
  return normalizePhoneFromCandidates(getPhoneCandidatesFromWebhook(body || {}, eventData, key));
}
function normalizeLocalPhone(value) {
  return String(value || "").replace(/\D/g, "");
}
function firstPhoneCandidate(...values) {
  for (const value of values) {
    const phone = normalizeLocalPhone(value);
    if (phone) return phone;
  }
  return "";
}
function getReceiverPhone(body) {
  const eventData = body?.data || body || {};
  const instance = body?.instanceData || body?.instance_data || eventData?.instanceData || eventData?.instance_data || {};
  const me = body?.me || eventData?.me || body?.account || eventData?.account || {};
  return firstPhoneCandidate(
    body?.receiver_phone,
    body?.receiverPhone,
    body?.recipient_phone,
    body?.recipientPhone,
    body?.to_phone,
    body?.toPhone,
    body?.bot_phone,
    body?.botPhone,
    body?.instance_phone,
    body?.instancePhone,
    body?.whatsapp_phone,
    body?.whatsappPhone,
    body?.whatspro_phone,
    body?.whatsproPhone,
    body?.receiver,
    body?.to,
    body?.recipient,
    eventData?.receiver_phone,
    eventData?.receiverPhone,
    eventData?.recipient_phone,
    eventData?.recipientPhone,
    eventData?.to_phone,
    eventData?.toPhone,
    eventData?.bot_phone,
    eventData?.botPhone,
    eventData?.instance_phone,
    eventData?.instancePhone,
    eventData?.whatsapp_phone,
    eventData?.whatsappPhone,
    eventData?.whatspro_phone,
    eventData?.whatsproPhone,
    eventData?.receiver,
    eventData?.to,
    eventData?.recipient,
    instance?.phone,
    instance?.number,
    instance?.jid,
    me?.phone,
    me?.number,
    me?.id,
    me?.jid
  );
}
async function resolveTenantInstance(req, _res, next) {
  const body = req.body || {};
  if (getInstanceId(body)) return next();
  try {
    const receiverPhone = getReceiverPhone(body);
    if (!receiverPhone) return next();
    const config = await getRestaurantConfigByWhatsAppPhone(receiverPhone);
    const instanceId = String(config?.instance_id || config?.instance || "").trim();
    if (instanceId) {
      req.body = {
        ...body,
        instance: instanceId,
        instance_id: instanceId
      };
      console.info(`[OPENBOT:TENANT] resolved instance=${instanceId} by_receiver=${maskPhone(receiverPhone)}`);
    }
    return next();
  } catch (error) {
    console.warn("[OPENBOT:TENANT:RESOLVE:FAIL]", error?.message || error);
    void notifyAllDevelopersSystemFailure(error, {
      scope: "tenant_resolution",
      customerPhone: maskPhone(getReceiverPhone(body))
    }).catch(() => void 0);
    return next();
  }
}
async function verifySecret(req, res, next) {
  const expected = process.env.OPENBOT_WEBHOOK_SECRET;
  const got = req.headers.authorization?.replace(/^Bearer\s+/i, "") || req.headers["x-api-key"] || req.body?.token || req.query?.token;
  if (expected && safeCompare(got, expected)) return next();
  try {
    const instanceId = getInstanceId(req.body || {});
    if (!instanceId) return res.status(401).json({ ok: false, error: "unauthorized" });
    const config = await getRestaurantConfig(instanceId);
    assertTenantSecret(req, config, "webhook");
    return next();
  } catch (error) {
    return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
  }
}
function isOwnWhatsAppMessage(body) {
  return body?.fromMe === true || body?.isFromMe === true || body?.data?.key?.fromMe === true;
}
function isGroupMessage(body) {
  const eventData = body?.data || body || {};
  const key = eventData?.key || body?.key || {};
  return Boolean(
    body?.isGroup === true || eventData?.isGroup === true || key?.remoteJid?.endsWith?.("@g.us") || key?.participant?.endsWith?.("@g.us") || String(body?.sender || eventData?.sender || body?.from || eventData?.from || "").endsWith("@g.us")
  );
}
function isStatusQuestion(text = "") {
  return STATUS_CONTEXT_RE.test(String(text || ""));
}
function runtimeUnavailableReply(ctx) {
  if (!isStatusQuestion(ctx.text)) return null;
  if (ctx.runtimeStatus) return null;
  return ctx.language === "kk" ? "\u049A\u0430\u0437\u0456\u0440 \u0430\u0441\u04AF\u0439 \u0441\u0442\u0430\u0442\u0443\u0441\u044B\u043D \u0442\u0435\u043A\u0441\u0435\u0440\u0435 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u043D. \u041A\u0435\u0439\u0456\u043D \u049B\u0430\u0439\u0442\u0430\u043B\u0430\u043F \u0436\u0430\u0437\u044B\u04A3\u044B\u0437." : "\u041D\u0435 \u043C\u043E\u0433\u0443 \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442\u044C \u0441\u0442\u0430\u0442\u0443\u0441 \u043A\u0443\u0445\u043D\u0438. \u041D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u043F\u043E\u0437\u0436\u0435.";
}
function unavailableOrderReply(language) {
  return language === "ru" ? "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u043B\u0443\u0447\u0438\u0442\u044C \u0430\u043A\u0442\u0443\u0430\u043B\u044C\u043D\u044B\u0439 \u0441\u0442\u0430\u0442\u0443\u0441 \u0437\u0430\u043A\u0430\u0437\u0430. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043D\u0435\u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0437\u0436\u0435." : "\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u0442\u044B\u04A3 \u04E9\u0437\u0435\u043A\u0442\u0456 \u0441\u0442\u0430\u0442\u0443\u0441\u044B\u043D \u0430\u043B\u0430 \u0430\u043B\u043C\u0430\u0434\u044B\u043C. \u0421\u04D9\u043B \u043A\u0435\u0439\u0456\u043D\u0456\u0440\u0435\u043A \u049B\u0430\u0439\u0442\u0430\u043B\u0430\u043F \u043A\u04E9\u0440\u0456\u04A3\u0456\u0437.";
}
function missingOrderReply(language) {
  return language === "ru" ? "\u0410\u043A\u0442\u0438\u0432\u043D\u044B\u0439 \u0437\u0430\u043A\u0430\u0437 \u043F\u043E \u044D\u0442\u043E\u043C\u0443 \u043D\u043E\u043C\u0435\u0440\u0443 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043D\u043E\u043C\u0435\u0440 \u0437\u0430\u043A\u0430\u0437\u0430." : "\u0411\u04B1\u043B \u043D\u04E9\u043C\u0456\u0440 \u0431\u043E\u0439\u044B\u043D\u0448\u0430 \u0431\u0435\u043B\u0441\u0435\u043D\u0434\u0456 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0442\u0430\u0431\u044B\u043B\u043C\u0430\u0434\u044B. \u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u043D\u04E9\u043C\u0456\u0440\u0456\u043D \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.";
}
async function customerOrderReply(ctx) {
  if (!isCustomerOrderStatusQuestion(ctx.text) && !(ctx.activeOrder && isLikelyOrderStatusFollowUp(ctx.text))) return null;
  const orderNumber = requestedOrderNumber(ctx.text);
  const lookup = orderNumber ? await getCustomerOrder(ctx.instanceId, String(ctx.config?.domain || ""), ctx.phone, ctx.language, orderNumber) : ctx.activeOrder?.is_stale ? { state: "unavailable" } : customerOrderFromRecord(ctx.activeOrder, ctx.phone, ctx.language);
  if (lookup.state === "found") return formatCustomerOrderStatus(lookup.order, ctx.language);
  if (lookup.state === "unavailable") return unavailableOrderReply(ctx.language);
  return missingOrderReply(ctx.language);
}
function busyKitchenReply(policy, language) {
  return language === "ru" ? `\u0421\u0435\u0439\u0447\u0430\u0441 \u043C\u043D\u043E\u0433\u043E \u0437\u0430\u043A\u0430\u0437\u043E\u0432, \u043F\u043E\u044D\u0442\u043E\u043C\u0443 \u043F\u0440\u0438\u0433\u043E\u0442\u043E\u0432\u043B\u0435\u043D\u0438\u0435 \u0438\u043B\u0438 \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430 \u043C\u043E\u0433\u0443\u0442 \u0437\u0430\u0434\u0435\u0440\u0436\u0430\u0442\u044C\u0441\u044F \u043F\u0440\u0438\u043C\u0435\u0440\u043D\u043E \u043D\u0430 ${policy.waitLabelRu}. \u0412\u044B \u0441\u043E\u0433\u043B\u0430\u0441\u043D\u044B \u043F\u043E\u0434\u043E\u0436\u0434\u0430\u0442\u044C \u0438 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0438\u0442\u044C?` : `\u049A\u0430\u0437\u0456\u0440 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u043A\u04E9\u043F \u0431\u043E\u043B\u0493\u0430\u043D\u0434\u044B\u049B\u0442\u0430\u043D \u0434\u0430\u0439\u044B\u043D\u0434\u0430\u0443 \u043D\u0435\u043C\u0435\u0441\u0435 \u0436\u0435\u0442\u043A\u0456\u0437\u0443 \u0448\u0430\u043C\u0430\u043C\u0435\u043D ${policy.waitLabelKk} \u043A\u0435\u0448\u0456\u0433\u0443\u0456 \u043C\u04AF\u043C\u043A\u0456\u043D. \u041A\u04AF\u0442\u0456\u043F, \u0436\u0430\u043B\u0493\u0430\u0441\u0442\u044B\u0440\u0443\u0493\u0430 \u043A\u0435\u043B\u0456\u0441\u0435\u0441\u0456\u0437 \u0431\u0435?`;
}
function closedKitchenReply(policy, language) {
  if (language === "ru") {
    if (policy.mode === "vacation") return `\u0421\u0435\u0439\u0447\u0430\u0441 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u043C \u0437\u0430\u043A\u0430\u0437\u044B${policy.remainingDays ? ` \u043F\u0440\u0438\u043C\u0435\u0440\u043D\u043E ${policy.remainingDays} \u0434\u043D.` : ""}. \u041D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u043D\u0430\u043C \u043D\u0435\u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0437\u0436\u0435 \u2014 \u043C\u044B \u0441\u043E\u043E\u0431\u0449\u0438\u043C \u0430\u043A\u0442\u0443\u0430\u043B\u044C\u043D\u0443\u044E \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u044E. \u0421\u043F\u0430\u0441\u0438\u0431\u043E \u0437\u0430 \u043F\u043E\u043D\u0438\u043C\u0430\u043D\u0438\u0435.`;
    if (policy.mode === "indefinite") return "\u041F\u043E \u0432\u0430\u0436\u043D\u043E\u0439 \u0442\u0435\u0445\u043D\u0438\u0447\u0435\u0441\u043A\u043E\u0439 \u043F\u0440\u0438\u0447\u0438\u043D\u0435 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u043C \u0437\u0430\u043A\u0430\u0437\u044B. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u043D\u0430\u043C \u043D\u0435\u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0437\u0436\u0435, \u0447\u0442\u043E\u0431\u044B \u0443\u0442\u043E\u0447\u043D\u0438\u0442\u044C \u0430\u043A\u0442\u0443\u0430\u043B\u044C\u043D\u0443\u044E \u0441\u0438\u0442\u0443\u0430\u0446\u0438\u044E. \u0421\u043F\u0430\u0441\u0438\u0431\u043E \u0437\u0430 \u043F\u043E\u043D\u0438\u043C\u0430\u043D\u0438\u0435.";
    return "\u041F\u043E \u0432\u0430\u0436\u043D\u043E\u0439 \u0442\u0435\u0445\u043D\u0438\u0447\u0435\u0441\u043A\u043E\u0439 \u043F\u0440\u0438\u0447\u0438\u043D\u0435 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u0435\u043C \u0437\u0430\u043A\u0430\u0437\u044B. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u043D\u0430\u043C \u043D\u0435\u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0437\u0436\u0435. \u0421\u043F\u0430\u0441\u0438\u0431\u043E \u0437\u0430 \u043F\u043E\u043D\u0438\u043C\u0430\u043D\u0438\u0435.";
  }
  if (policy.mode === "vacation") return `\u049A\u0430\u0437\u0456\u0440 \u0443\u0430\u049B\u044B\u0442\u0448\u0430 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043C\u0430\u0439\u043C\u044B\u0437${policy.remainingDays ? `, \u0448\u0430\u043C\u0430\u043C\u0435\u043D ${policy.remainingDays} \u043A\u04AF\u043D` : ""}. \u0411\u0456\u0440\u0430\u0437\u0434\u0430\u043D \u043A\u0435\u0439\u0456\u043D \u049B\u0430\u0439\u0442\u0430 \u0436\u0430\u0437\u044B\u043F, \u04E9\u0437\u0435\u043A\u0442\u0456 \u0436\u0430\u0493\u0434\u0430\u0439\u0434\u044B \u043D\u0430\u049B\u0442\u044B\u043B\u0430\u043F \u043A\u04E9\u0440\u0456\u04A3\u0456\u0437. \u0422\u04AF\u0441\u0456\u043D\u0456\u0441\u0442\u0456\u043A \u0442\u0430\u043D\u044B\u0442\u049B\u0430\u043D\u044B\u04A3\u044B\u0437\u0493\u0430 \u0440\u0430\u049B\u043C\u0435\u0442.`;
  if (policy.mode === "indefinite") return "\u041C\u0430\u04A3\u044B\u0437\u0434\u044B \u0442\u0435\u0445\u043D\u0438\u043A\u0430\u043B\u044B\u049B \u0441\u0435\u0431\u0435\u043F\u043A\u0435 \u0431\u0430\u0439\u043B\u0430\u043D\u044B\u0441\u0442\u044B \u0443\u0430\u049B\u044B\u0442\u0448\u0430 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043C\u0430\u0439\u043C\u044B\u0437. \u0411\u0456\u0440\u0430\u0437\u0434\u0430\u043D \u043A\u0435\u0439\u0456\u043D \u049B\u0430\u0439\u0442\u0430 \u0436\u0430\u0437\u044B\u043F, \u04E9\u0437\u0435\u043A\u0442\u0456 \u0436\u0430\u0493\u0434\u0430\u0439\u0434\u044B \u043D\u0430\u049B\u0442\u044B\u043B\u0430\u043F \u043A\u04E9\u0440\u0456\u04A3\u0456\u0437. \u0422\u04AF\u0441\u0456\u043D\u0456\u0441\u0442\u0456\u043A \u0442\u0430\u043D\u044B\u0442\u049B\u0430\u043D\u044B\u04A3\u044B\u0437\u0493\u0430 \u0440\u0430\u049B\u043C\u0435\u0442.";
  return "\u041C\u0430\u04A3\u044B\u0437\u0434\u044B \u0442\u0435\u0445\u043D\u0438\u043A\u0430\u043B\u044B\u049B \u0441\u0435\u0431\u0435\u043F\u043A\u0435 \u0431\u0430\u0439\u043B\u0430\u043D\u044B\u0441\u0442\u044B \u0443\u0430\u049B\u044B\u0442\u0448\u0430 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043C\u0430\u0439\u043C\u044B\u0437. \u0411\u0456\u0440\u0430\u0437\u0434\u0430\u043D \u043A\u0435\u0439\u0456\u043D \u049B\u0430\u0439\u0442\u0430 \u0436\u0430\u0437\u044B\u043F \u043A\u04E9\u0440\u0456\u04A3\u0456\u0437. \u0422\u04AF\u0441\u0456\u043D\u0456\u0441\u0442\u0456\u043A \u0442\u0430\u043D\u044B\u0442\u049B\u0430\u043D\u044B\u04A3\u044B\u0437\u0493\u0430 \u0440\u0430\u049B\u043C\u0435\u0442.";
}
function unavailableChannelReply(channel, language) {
  if (language === "ru") return channel === "delivery" ? "\u0421\u0435\u0439\u0447\u0430\u0441 \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0430 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430, \u043D\u043E \u043C\u043E\u0436\u043D\u043E \u043E\u0444\u043E\u0440\u043C\u0438\u0442\u044C \u0441\u0430\u043C\u043E\u0432\u044B\u0432\u043E\u0437." : "\u0421\u0435\u0439\u0447\u0430\u0441 \u0441\u0430\u043C\u043E\u0432\u044B\u0432\u043E\u0437 \u0432\u0440\u0435\u043C\u0435\u043D\u043D\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D, \u043D\u043E \u043C\u043E\u0436\u043D\u043E \u043E\u0444\u043E\u0440\u043C\u0438\u0442\u044C \u0434\u043E\u0441\u0442\u0430\u0432\u043A\u0443.";
  return channel === "delivery" ? "\u049A\u0430\u0437\u0456\u0440 \u0436\u0435\u0442\u043A\u0456\u0437\u0443 \u0443\u0430\u049B\u044B\u0442\u0448\u0430 \u049B\u043E\u043B\u0436\u0435\u0442\u0456\u043C\u0441\u0456\u0437, \u0431\u0456\u0440\u0430\u049B \u0430\u043B\u044B\u043F \u043A\u0435\u0442\u0443\u0433\u0435 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0431\u0435\u0440\u0435 \u0430\u043B\u0430\u0441\u044B\u0437." : "\u049A\u0430\u0437\u0456\u0440 \u0430\u043B\u044B\u043F \u043A\u0435\u0442\u0443 \u0443\u0430\u049B\u044B\u0442\u0448\u0430 \u049B\u043E\u043B\u0436\u0435\u0442\u0456\u043C\u0441\u0456\u0437, \u0431\u0456\u0440\u0430\u049B \u0436\u0435\u0442\u043A\u0456\u0437\u0443\u0433\u0435 \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0431\u0435\u0440\u0435 \u0430\u043B\u0430\u0441\u044B\u0437.";
}
async function kitchenGateReply(ctx) {
  if (ctx.activeOrder || await hasActiveKitchenCheckout(ctx.instanceId, ctx.phone).catch(() => false)) return null;
  const policy = classifyKitchenSalesPolicy(ctx.runtimeStatus);
  const pending = await getPendingKitchenConsent(ctx.instanceId, ctx.phone).catch(() => null);
  if (pending) {
    if (pending.policyFingerprint !== policy.fingerprint) await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
    else {
      const answer = detectKitchenConsentAnswer(ctx.text);
      if (answer === "yes") {
        await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
        return null;
      }
      if (answer === "no") {
        await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
        return ctx.language === "ru" ? "\u0425\u043E\u0440\u043E\u0448\u043E, \u0437\u0430\u043A\u0430\u0437 \u043D\u0435 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0430\u0435\u043C. \u0415\u0441\u043B\u0438 \u0440\u0435\u0448\u0438\u0442\u0435 \u043F\u043E\u0437\u0436\u0435 \u2014 \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u043D\u0430\u043C." : "\u0416\u0430\u049B\u0441\u044B, \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u0442\u044B \u0436\u0430\u043B\u0493\u0430\u0441\u0442\u044B\u0440\u043C\u0430\u0439\u043C\u044B\u0437. \u041A\u0435\u0439\u0456\u043D \u0448\u0435\u0448\u0441\u0435\u04A3\u0456\u0437, \u0431\u0456\u0437\u0433\u0435 \u0436\u0430\u0437\u044B\u04A3\u044B\u0437.";
      }
      return ctx.language === "ru" ? "\u041F\u043E\u0434\u0442\u0432\u0435\u0440\u0434\u0438\u0442\u0435, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430: \u0433\u043E\u0442\u043E\u0432\u044B \u043F\u043E\u0434\u043E\u0436\u0434\u0430\u0442\u044C \u2014 \u0434\u0430 \u0438\u043B\u0438 \u043D\u0435\u0442?" : "\u041D\u0430\u049B\u0442\u044B\u043B\u0430\u043F \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437\u0448\u0456: \u043A\u04AF\u0442\u0443\u0433\u0435 \u043A\u0435\u043B\u0456\u0441\u0435\u0441\u0456\u0437 \u0431\u0435 \u2014 \u0438\u04D9 \u043D\u0435\u043C\u0435\u0441\u0435 \u0436\u043E\u049B?";
    }
  }
  if (policy.blocksAllSales) return closedKitchenReply(policy, ctx.language);
  const channel = detectRequestedServiceChannel(ctx.text);
  if (channel === "delivery" && !policy.delivery) return unavailableChannelReply(channel, ctx.language);
  if (channel === "pickup" && !policy.pickup) return unavailableChannelReply(channel, ctx.language);
  if (policy.requiresConsent) {
    await savePendingKitchenConsent(ctx.instanceId, ctx.phone, policy.fingerprint);
    return busyKitchenReply(policy, ctx.language);
  }
  return null;
}
function hasMeaningfulMediaDescription(text = "", mediaContext = null) {
  const clean = stripEscalationSignals(text).trim();
  if (!clean || clean === "[Media sent]") return false;
  const historyLabel = String(mediaContext?.historyLabel || "").trim();
  if (historyLabel && clean === historyLabel) return false;
  return clean.length >= 2;
}
async function sendCustomerReplyAndFinish(ctx, messageId, reply, source) {
  const cleanReply = stripEscalationSignals(reply);
  if (cleanReply) {
    const delivery = await sendWhatsProResponseSequence({ instanceId: ctx.instanceId, phone: ctx.phone, text: cleanReply });
    if (!delivery.ok) throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", cleanReply, { source, ...noteHistoryMeta(ctx, cleanReply) });
  }
  await markInboundDone(ctx.instanceId, messageId);
  await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch(() => false);
}
async function processWhatsAppWebhook(body, started) {
  const instanceId = getInstanceId(body);
  const phone = getPhone(body);
  const messageId = extractMessageId(body);
  let mediaContext = extractInboundMedia(body);
  const senderMeta = extractSenderMeta(body);
  let text = extractInboundText(body) || mediaContext?.caption || mediaContext?.historyLabel || (mediaContext ? "[Media sent]" : "");
  let customerLanguageText = extractInboundText(body) || mediaContext?.caption || "";
  let stopTyping = () => {
  };
  console.log(
    `[OPENBOT:INBOUND] received instance=${instanceId || "-"} phone=${maskPhone(phone)} text_len=${String(text || "").length} media=${mediaContext?.kind || "no"} source=${body.source || "-"}`
  );
  try {
    if (!String(text || "").trim() && !mediaContext) {
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=empty_message elapsed=${Date.now() - started}ms`
      );
      return;
    }
    const guard = await guardIncomingMessage({
      instanceId,
      phone,
      text,
      messageId,
      fromMe: isOwnWhatsAppMessage(body),
      isGroup: isGroupMessage(body),
      senderMeta
    });
    if (guard.blocked) {
      if (guard.source === "operator_override") {
        await saveToHistory(String(instanceId || ""), String(phone || ""), "user", text || mediaContext?.historyLabel || "[operator override]", {
          source: "operator_override",
          media: safeMediaMetadata(mediaContext)
        });
      }
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=${guard.reason || "blocked"} elapsed=${Date.now() - started}ms`
      );
      return;
    }
    if (mediaContext?.kind === "sticker") {
      await markInboundDone(instanceId, messageId);
      return;
    }
    if (!mediaContext && text) {
      const buffered = await bufferInboundText({ instanceId, phone, messageId, text });
      if (!buffered.leader) {
        await markInboundDone(instanceId, messageId);
        return;
      }
      text = buffered.text || text;
      customerLanguageText = text;
    }
    stopTyping = startWhatsProTyping({ instanceId, phone });
    mediaContext = await hydrateInboundMedia(body, mediaContext);
    const ctx = await preloadContext({ instanceId, phone, text, languageCandidateText: customerLanguageText, mediaContext, senderMeta });
    console.log(
      `[OPENBOT:CONTEXT] loaded instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} lang=${ctx.language} domain=${ctx.config?.domain || "-"} runtime=${ctx.runtimeStatus ? "ok" : "missing"} wait=${ctx.hardRealtimeContext.wait_time ?? "-"} order=${ctx.activeOrder?.order_id || "none"} notes=${ctx.activeShiftNotes.length} history=${ctx.chatHistory.length} link_sent=${ctx.magicLinkAlreadySent}`
    );
    if (mediaContext?.kind === "video") {
      const reply = ctx.language === "ru" ? "\u0418\u0437\u0432\u0438\u043D\u0438\u0442\u0435, \u044F \u043D\u0435 \u043F\u0440\u0438\u043D\u0438\u043C\u0430\u044E \u0432\u0438\u0434\u0435\u043E. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043E\u043F\u0438\u0448\u0438\u0442\u0435, \u0447\u0442\u043E \u043F\u0440\u043E\u0438\u0437\u043E\u0448\u043B\u043E, \u0442\u0435\u043A\u0441\u0442\u043E\u043C \u0438\u043B\u0438 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0444\u043E\u0442\u043E." : "\u041A\u0435\u0448\u0456\u0440\u0456\u04A3\u0456\u0437, \u0432\u0438\u0434\u0435\u043E \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u0439 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u043D. \u041D\u0435 \u0431\u043E\u043B\u0493\u0430\u043D\u044B\u043D \u043C\u04D9\u0442\u0456\u043D\u043C\u0435\u043D \u0442\u04AF\u0441\u0456\u043D\u0434\u0456\u0440\u0456\u04A3\u0456\u0437 \u043D\u0435\u043C\u0435\u0441\u0435 \u0444\u043E\u0442\u043E \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.";
      await sendWhatsProResponseSequence({ instanceId: ctx.instanceId, phone: ctx.phone, text: reply });
      await markInboundDone(ctx.instanceId, messageId);
      return;
    }
    if (mediaContext && !mediaContext.valid) {
      if (mediaContext.reason === "voice_too_long") {
        const routing = await routeComplaintToAdmin(ctx, {
          summary: `\u041A\u043B\u0438\u0435\u043D\u0442 \u04B1\u0437\u0430\u049B \u0434\u0430\u0443\u044B\u0441\u0442\u044B\u049B \u0445\u0430\u0431\u0430\u0440\u043B\u0430\u043C\u0430 \u0436\u0456\u0431\u0435\u0440\u0434\u0456 (${mediaContext.durationSeconds || "?"} \u0441\u0435\u043A). \u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0434\u044B\u04A3 \u0436\u0430\u0443\u0430\u0431\u044B \u049B\u0430\u0436\u0435\u0442.`,
          customerText: text,
          customerReply: "",
          urgency: "normal",
          source: "long_voice_requires_operator"
        });
        const reply2 = ctx.language === "ru" ? routing.escalationAvailable ? "\u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0434\u043B\u0438\u043D\u043D\u043E\u0435 \u0434\u043B\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u043E\u0439 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u043A\u0438. \u042F \u043F\u0435\u0440\u0435\u0434\u0430\u043B \u043E\u0431\u0440\u0430\u0449\u0435\u043D\u0438\u0435 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0443." : "\u0413\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0434\u043B\u0438\u043D\u043D\u043E\u0435. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043A\u0440\u0430\u0442\u043A\u043E \u043E\u043F\u0438\u0448\u0438\u0442\u0435 \u0432\u043E\u043F\u0440\u043E\u0441 \u0442\u0435\u043A\u0441\u0442\u043E\u043C." : routing.escalationAvailable ? "\u0414\u0430\u0443\u044B\u0441\u0442\u044B\u049B \u0445\u0430\u0431\u0430\u0440\u043B\u0430\u043C\u0430 \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0442\u044B \u04E9\u04A3\u0434\u0435\u0443\u0433\u0435 \u0442\u044B\u043C \u04B1\u0437\u0430\u049B. \u04E8\u0442\u0456\u043D\u0456\u0448\u0442\u0456 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0493\u0430 \u0436\u0456\u0431\u0435\u0440\u0434\u0456\u043C." : "\u0414\u0430\u0443\u044B\u0441\u0442\u044B\u049B \u0445\u0430\u0431\u0430\u0440\u043B\u0430\u043C\u0430 \u0442\u044B\u043C \u04B1\u0437\u0430\u049B. \u041C\u04D9\u0441\u0435\u043B\u0435\u043D\u0456 \u043C\u04D9\u0442\u0456\u043D\u043C\u0435\u043D \u049B\u044B\u0441\u049B\u0430\u0448\u0430 \u0436\u0430\u0437\u044B\u043F \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.";
        await sendCustomerReplyAndFinish(ctx, messageId, reply2, "long_voice");
        return;
      }
      const reply = mediaContext.reason === "media_too_large" ? mediaContext.kind === "audio" ? ctx.language === "ru" ? "\u0410\u0443\u0434\u0438\u043E\u0444\u0430\u0439\u043B \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0438\u043B\u0438 \u043A\u0440\u0430\u0442\u043A\u043E \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0432\u043E\u043F\u0440\u043E\u0441." : "\u0410\u0443\u0434\u0438\u043E\u0444\u0430\u0439\u043B \u0442\u044B\u043C \u04AF\u043B\u043A\u0435\u043D. \u049A\u044B\u0441\u049B\u0430 \u0434\u0430\u0443\u044B\u0441\u0442\u044B\u049B \u0445\u0430\u0431\u0430\u0440\u043B\u0430\u043C\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437 \u043D\u0435\u043C\u0435\u0441\u0435 \u0441\u04B1\u0440\u0430\u049B\u0442\u044B \u043C\u04D9\u0442\u0456\u043D\u043C\u0435\u043D \u0436\u0430\u0437\u044B\u04A3\u044B\u0437." : ctx.language === "ru" ? "\u0424\u0430\u0439\u043B \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u0431\u043E\u043B\u044C\u0448\u043E\u0439. \u0424\u043E\u0442\u043E \u0438\u043B\u0438 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442 \u0434\u043E\u043B\u0436\u0435\u043D \u0431\u044B\u0442\u044C \u043D\u0435 \u0431\u043E\u043B\u044C\u0448\u0435 5 \u041C\u0411." : "\u0424\u0430\u0439\u043B \u043A\u04E9\u043B\u0435\u043C\u0456 \u0442\u044B\u043C \u04AF\u043B\u043A\u0435\u043D. \u0424\u043E\u0442\u043E \u043D\u0435\u043C\u0435\u0441\u0435 \u049B\u04B1\u0436\u0430\u0442 5 \u041C\u0411-\u0442\u0430\u043D \u0430\u0441\u043F\u0430\u0443\u044B \u043A\u0435\u0440\u0435\u043A." : mediaContext.reason === "music_audio_not_supported" ? ctx.language === "ru" ? "\u041C\u0443\u0437\u044B\u043A\u0443 \u0438 \u043E\u0431\u044B\u0447\u043D\u044B\u0435 \u0430\u0443\u0434\u0438\u043E\u0444\u0430\u0439\u043B\u044B \u043D\u0435 \u043E\u0431\u0440\u0430\u0431\u0430\u0442\u044B\u0432\u0430\u044E. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0438\u043B\u0438 \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0442\u0435\u043A\u0441\u0442\u043E\u043C." : "\u041C\u0443\u0437\u044B\u043A\u0430 \u043C\u0435\u043D \u043A\u04D9\u0434\u0456\u043C\u0433\u0456 \u0430\u0443\u0434\u0438\u043E\u0444\u0430\u0439\u043B\u0434\u0430\u0440\u0434\u044B \u04E9\u04A3\u0434\u0435\u0439 \u0430\u043B\u043C\u0430\u0439\u043C\u044B\u043D. \u049A\u044B\u0441\u049B\u0430 \u0434\u0430\u0443\u044B\u0441\u0442\u044B\u049B \u0445\u0430\u0431\u0430\u0440\u043B\u0430\u043C\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437 \u043D\u0435\u043C\u0435\u0441\u0435 \u043C\u04D9\u0442\u0456\u043D\u043C\u0435\u043D \u0436\u0430\u0437\u044B\u04A3\u044B\u0437." : mediaContext.reason === "unsupported_document" || mediaContext.reason === "unsupported_mime_type" || mediaContext.reason === "unsupported_audio_mime" ? ctx.language === "ru" ? "\u042D\u0442\u043E\u0442 \u0444\u043E\u0440\u043C\u0430\u0442 \u0444\u0430\u0439\u043B\u0430 \u043D\u0435 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u0442\u0441\u044F. \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0444\u043E\u0442\u043E JPG/PNG/WEBP, PDF \u0438\u043B\u0438 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 \u0433\u043E\u043B\u043E\u0441\u043E\u0432\u043E\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435." : "\u0411\u04B1\u043B \u0444\u0430\u0439\u043B \u0444\u043E\u0440\u043C\u0430\u0442\u044B \u049B\u043E\u043B\u0434\u0430\u0443 \u0442\u0430\u043F\u043F\u0430\u0439\u0434\u044B. JPG/PNG/WEBP \u0444\u043E\u0442\u043E, PDF \u043D\u0435\u043C\u0435\u0441\u0435 \u049B\u044B\u0441\u049B\u0430 \u0434\u0430\u0443\u044B\u0441\u0442\u044B\u049B \u0445\u0430\u0431\u0430\u0440\u043B\u0430\u043C\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437." : ctx.language === "ru" ? "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E \u0437\u0430\u0433\u0440\u0443\u0437\u0438\u0442\u044C \u0444\u0430\u0439\u043B. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0435\u0433\u043E \u0435\u0449\u0451 \u0440\u0430\u0437 \u0438\u043B\u0438 \u043E\u043F\u0438\u0448\u0438\u0442\u0435 \u0432\u043E\u043F\u0440\u043E\u0441 \u0442\u0435\u043A\u0441\u0442\u043E\u043C." : "\u0424\u0430\u0439\u043B\u0434\u044B \u049B\u0430\u0443\u0456\u043F\u0441\u0456\u0437 \u0436\u04AF\u043A\u0442\u0435\u0439 \u0430\u043B\u043C\u0430\u0434\u044B\u043C. \u049A\u0430\u0439\u0442\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437 \u043D\u0435\u043C\u0435\u0441\u0435 \u043C\u04D9\u0441\u0435\u043B\u0435\u043D\u0456 \u043C\u04D9\u0442\u0456\u043D\u043C\u0435\u043D \u0436\u0430\u0437\u044B\u04A3\u044B\u0437.";
      await sendCustomerReplyAndFinish(ctx, messageId, reply, `media_rejected:${mediaContext.reason || "invalid"}`);
      return;
    }
    let mediaPreemptiveReply = "";
    let mediaPreemptiveSource = "";
    let mediaDeveloperError = "";
    let immediateComplaintSummary = "";
    let immediateComplaintMedia = null;
    let immediateComplaintUrgency = "normal";
    if (mediaContext?.base64 && mediaContext.valid) {
      if (!await claimMediaAiQuota(ctx.instanceId, ctx.phone)) {
        const reply = ctx.language === "ru" ? "\u0421\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u043D\u043E\u0433\u043E \u043C\u0435\u0434\u0438\u0430\u0444\u0430\u0439\u043B\u043E\u0432 \u0437\u0430 \u043A\u043E\u0440\u043E\u0442\u043A\u043E\u0435 \u0432\u0440\u0435\u043C\u044F. \u041F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u043D\u0435\u0441\u043A\u043E\u043B\u044C\u043A\u043E \u043C\u0438\u043D\u0443\u0442 \u0438 \u043F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u0441\u043D\u043E\u0432\u0430." : "\u049A\u044B\u0441\u049B\u0430 \u0443\u0430\u049B\u044B\u0442\u0442\u0430 \u043C\u0435\u0434\u0438\u0430\u0444\u0430\u0439\u043B \u0442\u044B\u043C \u043A\u04E9\u043F \u0436\u0456\u0431\u0435\u0440\u0456\u043B\u0434\u0456. \u0411\u0456\u0440\u043D\u0435\u0448\u0435 \u043C\u0438\u043D\u0443\u0442 \u043A\u04AF\u0442\u0456\u043F, \u049B\u0430\u0439\u0442\u0430 \u043A\u04E9\u0440\u0456\u04A3\u0456\u0437.";
        await sendCustomerReplyAndFinish(ctx, messageId, reply, "media_rate_limited");
        return;
      }
      const activeOrder = ctx.activeOrder?.order || ctx.activeOrder || {};
      const receiptContext = {
        expectedAmount: Number(ctx.activeOrder?.total_price || activeOrder.total_price || activeOrder.total || 0),
        orderCreatedAt: String(activeOrder.created_at || activeOrder.createdAt || ""),
        nowMs: Date.now()
      };
      const recentDialog = ctx.chatHistory.slice(-4).map((entry) => `${entry?.role || "user"}: ${String(entry?.text || "").slice(0, 300)}`).join("\n");
      const mediaAnalysis = await analyzeMedia(
        mediaContext.base64,
        mediaContext.mimeType || mediaContext.mediaType || "application/octet-stream",
        `${text}

[RECENT DIALOGUE FOR CONTEXT ONLY]
${recentDialog}`.slice(0, 1800),
        ctx.language,
        (mediaContext.mimeType || "").includes("pdf"),
        "",
        receiptContext
      );
      if (mediaAnalysis) {
        mediaContext = { ...mediaContext, analysis: mediaAnalysis };
        ctx.mediaContext = mediaContext;
        if (mediaAnalysis.type === "receipt") {
          const strictFilter = receiptFilterEnabled();
          const validation = validateReceiptAnalysis(mediaAnalysis, receiptContext);
          if (strictFilter && !validation.valid) {
            await sendCustomerReplyAndFinish(
              ctx,
              messageId,
              rejectedReceiptReply(ctx.language, validation.reason),
              `payment_receipt_rejected:${validation.reason}`
            );
            return;
          }
          const fingerprint = createReceiptFingerprint(String(mediaContext.base64 || ""), mediaAnalysis);
          if (!await claimReceiptFingerprint(ctx.instanceId, fingerprint)) {
            const duplicateReply = ctx.language === "ru" ? "\u042D\u0442\u043E\u0442 \u0447\u0435\u043A \u0443\u0436\u0435 \u0431\u044B\u043B \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0439\u0442\u0435 \u043E\u0434\u0438\u043D \u0447\u0435\u043A \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E." : "\u0411\u04B1\u043B \u0447\u0435\u043A \u0431\u04B1\u0440\u044B\u043D \u0436\u0456\u0431\u0435\u0440\u0456\u043B\u0433\u0435\u043D. \u0411\u0456\u0440 \u0447\u0435\u043A\u0442\u0456 \u049B\u0430\u0439\u0442\u0430 \u0436\u0456\u0431\u0435\u0440\u043C\u0435\u04A3\u0456\u0437.";
            await sendCustomerReplyAndFinish(ctx, messageId, duplicateReply, "payment_receipt_duplicate");
            return;
          }
          const receiptOrderNumber = mediaAnalysis.order_id !== "0" ? String(mediaAnalysis.order_id) : String(activeOrder.id || activeOrder.order_id || "");
          const receiptOrder = await getCustomerOrder(
            ctx.instanceId,
            String(ctx.config?.domain || ""),
            ctx.phone,
            ctx.language,
            receiptOrderNumber
          );
          if (receiptOrder.state !== "found") {
            await releaseReceiptFingerprint(ctx.instanceId, fingerprint);
            await sendCustomerReplyAndFinish(
              ctx,
              messageId,
              rejectedReceiptReply(ctx.language, "order_not_found"),
              "payment_receipt_order_not_found"
            );
            return;
          }
          const delivery = await deliverReceiptToClient({
            instanceId: ctx.instanceId,
            phone: ctx.phone,
            orderNumber: receiptOrder.order.orderNumber,
            config: ctx.config,
            amount: mediaAnalysis.amount,
            senderName: mediaAnalysis.sender_name,
            bankName: mediaAnalysis.bank_name,
            transactionId: mediaAnalysis.transaction_id,
            paidAt: mediaAnalysis.date_time
          });
          if (!delivery.success) {
            await releaseReceiptFingerprint(ctx.instanceId, fingerprint);
            const retryReply = ctx.language === "ru" ? "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0435\u0440\u0435\u0434\u0430\u0442\u044C \u0447\u0435\u043A \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0443. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0435\u0433\u043E \u0435\u0449\u0451 \u0440\u0430\u0437 \u0447\u0443\u0442\u044C \u043F\u043E\u0437\u0436\u0435." : "\u0427\u0435\u043A\u0442\u0456 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0493\u0430 \u0436\u0456\u0431\u0435\u0440\u0435 \u0430\u043B\u043C\u0430\u0434\u044B\u043C. \u0421\u04D9\u043B\u0434\u0435\u043D \u043A\u0435\u0439\u0456\u043D \u049B\u0430\u0439\u0442\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u04A3\u0456\u0437.";
            await sendCustomerReplyAndFinish(ctx, messageId, retryReply, "payment_receipt_crm_failed");
            return;
          }
          const receiptReply = ctx.language === "ru" ? "\u{1F9FE} \u0411\u043E\u043B\u044C\u0448\u043E\u0435 \u0441\u043F\u0430\u0441\u0438\u0431\u043E \u0437\u0430 \u043E\u043F\u043B\u0430\u0442\u0443! \u0427\u0435\u043A \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0443 \u043D\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443. \u041F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430, \u043D\u0435\u043C\u043D\u043E\u0433\u043E \u043F\u043E\u0434\u043E\u0436\u0434\u0438\u0442\u0435 \u23F3" : "\u{1F9FE} \u0422\u04E9\u043B\u0435\u043C\u0456\u04A3\u0456\u0437 \u04AF\u0448\u0456\u043D \u043A\u04E9\u043F \u0440\u0430\u049B\u043C\u0435\u0442! \u0427\u0435\u043A \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0493\u0430 \u0442\u0435\u043A\u0441\u0435\u0440\u0443\u0433\u0435 \u0436\u0456\u0431\u0435\u0440\u0456\u043B\u0434\u0456. \u041A\u0456\u0448\u043A\u0435\u043D\u0435 \u043A\u04AF\u0442\u0435 \u0442\u04B1\u0440\u044B\u04A3\u044B\u0437 \u23F3";
          await sendCustomerReplyAndFinish(ctx, messageId, receiptReply, "payment_receipt");
          return;
        }
        if (mediaAnalysis.type === "technical_error") {
          mediaDeveloperError = mediaAnalysis.analysis || "media_analysis_failed";
          mediaPreemptiveReply = mediaAnalysis.reply_to_customer || stripEscalationSignals(mediaAnalysis.analysis) || (ctx.language === "ru" ? "\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C \u0444\u0430\u0439\u043B. \u041F\u043E\u043F\u0440\u043E\u0431\u0443\u0439\u0442\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0435\u0433\u043E \u0435\u0449\u0435 \u0440\u0430\u0437 \u0447\u0443\u0442\u044C \u043F\u043E\u0437\u0436\u0435." : "\u0424\u0430\u0439\u043B\u0434\u044B \u04E9\u04A3\u0434\u0435\u0439 \u0430\u043B\u043C\u0430\u0434\u044B\u043C. \u0421\u04D9\u043B\u0434\u0435\u043D \u0441\u043E\u04A3 \u049B\u0430\u0439\u0442\u0430 \u0436\u0456\u0431\u0435\u0440\u0456\u043F \u043A\u04E9\u0440\u0456\u04A3\u0456\u0437.");
          mediaPreemptiveSource = "media_technical_error";
        }
        if (mediaAnalysis.type === "reply") {
          mediaPreemptiveReply = stripEscalationSignals(mediaAnalysis.analysis);
          mediaPreemptiveSource = mediaContext.kind === "audio" ? "voice_reply" : "media_reply";
        }
        if (mediaAnalysis.type === "complaint" && mediaContext.base64) {
          await saveComplaintMedia(ctx.instanceId, ctx.phone, mediaContext.base64, mediaContext.mimeType || mediaContext.mediaType || "image/jpeg");
          if (!hasMeaningfulMediaDescription(text, mediaContext)) {
            mediaPreemptiveReply = buildComplaintClarificationReply(ctx.language);
            mediaPreemptiveSource = "complaint_media_needs_text";
          } else {
            immediateComplaintSummary = mediaAnalysis.admin_summary || mediaAnalysis.analysis || text;
            immediateComplaintMedia = {
              base64: mediaContext.base64,
              mimeType: mediaContext.mimeType || mediaContext.mediaType || "image/jpeg"
            };
            immediateComplaintUrgency = "high";
            mediaPreemptiveReply = mediaAnalysis.reply_to_customer || stripEscalationSignals(mediaAnalysis.analysis) || buildComplaintAckReply(ctx.language);
            mediaPreemptiveSource = "media_complaint";
          }
        }
      }
    }
    await syncKanbanEvent(ctx, {
      event: "openbot_inbound",
      message_id: messageId || void 0,
      text,
      media: safeMediaMetadata(mediaContext)
    });
    if (mediaContext) {
      await saveMediaContext(ctx.instanceId, ctx.phone, mediaContext);
    }
    await saveToHistory(ctx.instanceId, ctx.phone, "user", ctx.text, {
      source: "openbot-agent",
      media: safeMediaMetadata(mediaContext)
    });
    if (mediaDeveloperError) {
      await notifyDeveloperSystemFailure(ctx.instanceId, new Error(mediaDeveloperError), {
        scope: "media_analysis",
        messageId,
        customerPhone: maskPhone(ctx.phone)
      }).catch(() => void 0);
      await sendCustomerReplyAndFinish(ctx, messageId, mediaPreemptiveReply, mediaPreemptiveSource);
      return;
    }
    if (immediateComplaintSummary) {
      const routing = await routeComplaintToAdmin(ctx, {
        summary: immediateComplaintSummary,
        customerText: text,
        customerReply: mediaPreemptiveReply,
        urgency: immediateComplaintUrgency,
        media: immediateComplaintMedia,
        source: "media_analysis"
      });
      await saveToHistory(ctx.instanceId, ctx.phone, "system", "operator case created", {
        source: "operator-case",
        caseId: routing.caseId,
        mediaAttached: routing.mediaAttached
      });
      if (!routing.escalationAvailable) {
        await notifyDeveloperSystemFailure(ctx.instanceId, new Error("ADMIN_PHONE_NOT_CONFIGURED_FOR_COMPLAINT"), {
          scope: "complaint-routing",
          messageId,
          customerPhone: maskPhone(ctx.phone)
        }).catch(() => void 0);
      }
      await sendCustomerReplyAndFinish(ctx, messageId, routing.customerReply, mediaPreemptiveSource || "media_complaint");
      return;
    }
    if (mediaPreemptiveReply) {
      await sendCustomerReplyAndFinish(ctx, messageId, mediaPreemptiveReply, mediaPreemptiveSource || "media_preemptive_reply");
      return;
    }
    const orderReply = await customerOrderReply(ctx);
    if (orderReply) {
      await sendCustomerReplyAndFinish(ctx, messageId, orderReply, "customer_order_status");
      return;
    }
    const kitchenReply = await kitchenGateReply(ctx);
    if (kitchenReply) {
      await sendCustomerReplyAndFinish(ctx, messageId, kitchenReply, "kitchen_policy");
      return;
    }
    const runtimeReply = runtimeUnavailableReply(ctx);
    if (runtimeReply) {
      console.log(`[OPENBOT:PREEMPT] runtime unavailable, using fallback`);
      await sendCustomerReplyAndFinish(ctx, messageId, runtimeReply, "runtime_unavailable");
      return;
    }
    const textModels = getTextModels();
    console.log(`[OPENBOT:AI] generating provider=openrouter primary=${textModels.primary} fallback=${textModels.fallback}`);
    const result = await runFastFoodAgent(ctx);
    console.log(`[OPENBOT:AI] completed chars=${result.text.length} finish=${result.finishReason || "-"} link=${result.hasLink}`);
    const rawAiText = String(result.rawText || result.text || "");
    const needsDeveloperEscalation = hasEscalateDeveloperSignal(rawAiText) || hasEscalateDeveloperSignal(result.text);
    const needsAdminEscalation = hasEscalateAdminSignal(rawAiText) || hasEscalateAdminSignal(result.text);
    const pendingComplaintMedia = await hasPendingComplaintMedia(ctx.instanceId, ctx.phone);
    const shouldRouteComplaint = needsAdminEscalation || pendingComplaintMedia || isLikelyComplaintText(ctx.text) || isLikelyOperatorRequestText(ctx.text);
    const finalText = stripEscalationSignals(result.text) || (shouldRouteComplaint ? buildComplaintAckReply(ctx.language) : result.text);
    if (needsDeveloperEscalation) {
      await notifyDeveloperSystemFailure(ctx.instanceId, new Error("AI requested developer escalation"), {
        scope: "ai-router",
        messageId,
        customerPhone: maskPhone(ctx.phone)
      }).catch(() => void 0);
    }
    if (shouldRouteComplaint) {
      const routing = await routeComplaintToAdmin(ctx, {
        summary: stripEscalationSignals(rawAiText || finalText || ctx.text),
        customerText: ctx.text,
        customerReply: finalText,
        urgency: needsAdminEscalation ? "high" : "normal",
        source: needsAdminEscalation ? "ai_escalation_signal" : pendingComplaintMedia ? "pending_complaint_media" : detectOperatorCaseKind(ctx.text) || "complaint_text"
      });
      await saveToHistory(ctx.instanceId, ctx.phone, "system", "operator case created", {
        source: "operator-case",
        caseId: routing.caseId,
        mediaAttached: routing.mediaAttached
      });
      if (!routing.escalationAvailable) {
        await notifyDeveloperSystemFailure(ctx.instanceId, new Error("ADMIN_PHONE_NOT_CONFIGURED_FOR_COMPLAINT"), {
          scope: "complaint-routing",
          messageId,
          customerPhone: maskPhone(ctx.phone)
        }).catch(() => void 0);
      }
    }
    void evaluateForShpor(ctx.text, finalText).then((evaluation) => {
      if (evaluation.save) {
        return saveToShpor(ctx.instanceId, ctx.text, finalText, evaluation.category || "faq", evaluation.memory || null);
      }
      return void 0;
    }).catch((error) => {
      console.warn("[SHPOR:EVAL] async save skipped:", error?.message || error);
      void notifyDeveloperSystemFailure(ctx.instanceId, error, {
        scope: "shpor_async_save",
        messageId,
        customerPhone: maskPhone(ctx.phone)
      }).catch(() => void 0);
    });
    const sendResult = await sendWhatsProResponseSequence({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      text: finalText
    });
    if (!sendResult.ok) throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", finalText, { source: "openbot-agent", ...noteHistoryMeta(ctx, finalText) });
    await markInboundDone(ctx.instanceId, messageId);
    await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch(() => false);
    console.log(
      `[OPENBOT:OUTBOUND] sent instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} chunks=${sendResult.chunks || 0} ok=${Boolean(sendResult?.ok)} link_in_text=${result.hasLink} elapsed=${Date.now() - started}ms`
    );
  } catch (error) {
    await clearInboundProcessing(String(instanceId || ""), messageId).catch(() => void 0);
    await notifyDeveloperSystemFailure(String(instanceId || ""), error, {
      scope: "whatsapp_webhook",
      messageId,
      customerPhone: maskPhone(phone)
    }).catch(() => void 0);
    throw error;
  } finally {
    stopTyping();
  }
}
function whatsappWebhookRoute() {
  const router = createRouter();
  router.post("/", resolveTenantInstance, verifySecret, async (req, res) => {
    const started = Date.now();
    const body = req.body || {};
    console.info(
      `[OPENBOT:WEBHOOK] fromMe=${isOwnWhatsAppMessage(body)} instance=${getInstanceId(body) || "-"} phone=${maskPhone(getPhone(body))}`
    );
    if (isOwnWhatsAppMessage(body)) {
      const instanceId = getInstanceId(body);
      const phone = getPhone(body);
      const opText = extractInboundText(body) || "[\u041E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0441\u04E9\u0439\u043B\u0435\u0434\u0456]";
      await setOperatorAutoMute(instanceId, phone).catch((error) => {
        console.warn("[OPENBOT:OPERATOR:MUTE:FAIL]", error?.message || error);
        void notifyDeveloperSystemFailure(instanceId, error, {
          scope: "operator_auto_mute",
          customerPhone: maskPhone(phone)
        }).catch(() => void 0);
      });
      if (instanceId && phone && opText) {
        await saveToHistory(instanceId, phone, "operator", opText, { source: "operator_from_me" }).catch((error) => {
          console.warn("[OPENBOT:OPERATOR:HISTORY:FAIL]", error?.message || error);
          void notifyDeveloperSystemFailure(instanceId, error, {
            scope: "operator_history",
            customerPhone: maskPhone(phone)
          }).catch(() => void 0);
        });
      }
      console.log(`[OPENBOT:INBOUND:SKIP] fromMe=true elapsed=${Date.now() - started}ms`);
      return res.status(202).json({ ok: true, skipped: true, reason: "fromMe" });
    }
    const mediaContext = extractInboundMedia(body);
    const text = extractInboundText(body) || mediaContext?.caption || mediaContext?.historyLabel || (mediaContext ? "[Media sent]" : "");
    if (!String(text || "").trim() && !mediaContext) {
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${getInstanceId(body) || "-"} phone=${maskPhone(getPhone(body))} reason=empty_message elapsed=${Date.now() - started}ms`
      );
      return res.status(200).send("ok");
    }
    setImmediate(() => {
      void processWhatsAppWebhook(body, started).catch((error) => {
        console.error(`[OPENBOT:INBOUND:FAIL] elapsed=${Date.now() - started}ms:`, error?.stack || error?.message || error);
      });
    });
    return res.status(202).json({ ok: true, accepted: true });
  });
  return router;
}
export {
  whatsappWebhookRoute
};

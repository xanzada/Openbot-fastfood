import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { refreshCheckoutContextForText } from "../services/checkoutIntent.service.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import { recordTurnTrace, refreshCustomerMemory } from "../services/customerMemory.service.js";
import {
claimReceiptFingerprint,
  clearPendingKitchenConsent,
  getKitchenCheckoutFingerprint,
  getLastKnownOrderId,
  getPendingKitchenConsent,
  hasReceiptSeen,
  hasComplaintClarificationPending,
  markComplaintClarificationPending,
  markKitchenCheckoutStarted,
  markMagicLinkSent,
  markReceiptSeen,
  releaseReceiptFingerprint,
  saveComplaintMedia,
  savePendingKitchenConsent,
  saveToHistory,
  takeComplaintClarification,
} from "../services/redis.service.js";
import { issueCustomerAccessLink, upsertCustomerLead } from "../services/alemiApi.service.js";
import { isLikelyMenuQuestion } from "../utils/intentText.js";
import {
  buildComplaintAckReply,
  buildComplaintClarificationReply,
  buildEscalationClarifyQuestion,
  buildEvidenceSeenReply,
  complaintHasActionableDetail,
  hasEscalateAdminSignal,
  hasPendingComplaintMedia,
  isLikelyComplaintText,
  isLikelyOperatorRequestText,
  routeComplaintToAdmin,
  stripEscalationSignals,
  type ComplaintMediaPayload,
  type ComplaintUrgency,
} from "../services/complaintRouting.service.js";
import {
  acquireTurnLock,
  bufferInboundText,
  claimMediaAiQuota,
  claimOutboundReply,
  drainInboundBuffer,
  requeueInboundText,
  releaseTurnLock,
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
  setOperatorAutoMute,
} from "../services/inboundGuard.service.js";
import { syncKanbanEvent } from "../services/kanbanSync.service.js";
import { notifyAllDevelopersSystemFailure, notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { markWhatsProChatRead, sendWhatsProResponseSequence, startWhatsProTyping } from "../transport/whatspro.client.js";
import { resolvePaceUrgency } from "../services/responsePlan.service.js";
import { getPhoneCandidatesFromWebhook, normalizePhoneFromCandidates } from "../services/dle.service.js";
import { customerOrderFromRecord, pickConversationOrder, formatCustomerOrderStatus, getCustomerOrder } from "../services/customerOrder.service.js";
import { deliverReceiptToClient } from "../services/receiptDelivery.service.js";
import { getPaymentRequisitesText } from "../controllers/kanban.js";
import { evaluateForShpor, getRestaurantConfig, getRestaurantConfigByWhatsAppPhone, isTenantBotEnabled, saveToShpor } from "../services/platformConfig.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import {
  analyzeMedia,
  createReceiptFingerprint,
  receiptFilterEnabled,
  validateReceiptAnalysis,
  voiceTranscriptForAgent,
} from "../services/mediaAnalysis.service.js";
import { detectLanguageDecision } from "../utils/language.js";
import { getTextModels } from "../services/llm.service.js";
import { getRuntimeSettings, runtimeTestModeEnabled } from "../services/llmWorkspace.service.js";
import { classifyKitchenSalesPolicyForContext, consentRequirement, formatKitchenWait, detectKitchenConsentAnswer, detectRequestedServiceChannel, type KitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
import { hasMenuBrowsingIntent, isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp, isOrderTimingQuestion, isProspectiveOrderTimingQuestion, isUnownedOrderTimingQuestion, lastDiscussedOrderNumber, requestedOrderNumber } from "../utils/orderIntent.js";
import type { FastFoodContext } from "../context/types.js";
import { noteHistoryMeta } from "../services/noteProvenance.service.js";
import {
  buildBlockedMenuItemReply,
  buildUnverifiedPaymentClaimReply,
  findBlockedMenuItemMention,
  isUnverifiedPaymentClaim,
} from "../services/operationalPreemption.service.js";
import { bumpOperatorCaseSignal, detectOperatorCaseKind, isOrderCancellationRequest } from "../services/operatorCase.service.js";
import { computeProactiveSignals } from "../services/proactiveSignals.service.js";
import { updateGoalAfterTurn } from "../services/goalTracker.service.js";
import { recordLearningEvent } from "../services/learningLoop.service.js";
import { bumpMetric, recordLatency } from "../services/metrics.service.js";
import { mergeBufferedParts } from "../services/bufferBrain.service.js";

const STATUS_CONTEXT_RE = /(асүй|ас үй|кухн|kitchen|повар|cook|статус|status|ашылды ма|жабық па|жұмыс істеп жатыр|работает|открыт|закрыт|готов|дайын)/iu;


function maskPhone(phone = "") {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length <= 6) return clean || "-";
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

function rejectedReceiptReply(language: "kk" | "ru", reason: string) {
  if (language === "ru") {
    if (reason === "amount_mismatch") return "Сумма в чеке не совпадает с суммой заказа. Отправьте, пожалуйста, правильный чек.";
    if (["receipt_too_old", "receipt_before_order"].includes(reason)) return "Этот чек старый или был создан до заказа. Отправьте новый чек по текущему заказу.";
    if (reason === "receipt_in_future") return "Дата на чеке указана в будущем. Отправьте, пожалуйста, корректный текущий чек.";
    if (reason === "order_not_found") return "По этому чеку не нахожу активного заказа. Сначала оформите заказ, затем отправьте чек об оплате.";
    return "Не удалось подтвердить подлинность чека. Отправьте, пожалуйста, свежий полный чек, где видны имя отправителя, банк, сумма и дата.";
  }
  if (reason === "amount_mismatch") return "Чектегі сома тапсырыс сомасына сәйкес емес. Дұрыс чекті жіберіңіз.";
  if (["receipt_too_old", "receipt_before_order"].includes(reason)) return "Бұл чек ескі немесе тапсырыстан бұрын жасалған. Осы тапсырысқа арналған жаңа чекті жіберіңіз.";
  if (reason === "receipt_in_future") return "Чектегі күн болашақ уақытты көрсетеді. Дұрыс, ағымдағы чекті жіберіңіз.";
  if (reason === "order_not_found") return "Бұл чекке сәйкес белсенді тапсырыс табылмады. Алдымен тапсырысты реттеп, содан кейін төлем чегін жіберіңіз.";
  return "Чектің дұрыстығын растай алмадым. Жіберушінің аты, банк, сома және күні анық көрінетін толық жаңа чекті жіберіңіз.";
}

function getInstanceId(body: any) {
  return String(
    body?.instance ||
    body?.instanceId ||
    body?.instance_id ||
    body?.restaurant_id ||
    body?.restaurant_instance ||
    body?.restaurantInstance ||
    body?.data?.instance ||
    body?.data?.instanceId ||
    body?.data?.instance_id ||
    body?.data?.restaurant_id ||
    ""
  ).trim();
}

// Internal incident alarms are developer-only. If one ever echoes back through the
// gateway it must be dropped, never answered as a guest message.
const DEVELOPER_ALERT_MARKER_RE = /(?:⚠️\s*)?OPENBOT\s+АҚАУЫ/i;

function getPhone(body: any) {
  const eventData = body?.data || body || {};
  const key = eventData?.key || body?.key || {};
  return normalizePhoneFromCandidates(getPhoneCandidatesFromWebhook(body || {}, eventData, key));
}

function normalizeLocalPhone(value: unknown) {
  return String(value || "").replace(/\D/g, "");
}

function firstPhoneCandidate(...values: unknown[]) {
  for (const value of values) {
    const phone = normalizeLocalPhone(value);
    if (phone) return phone;
  }
  return "";
}

function getReceiverPhone(body: any) {
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

async function resolveTenantInstance(req: Request, _res: Response, next: NextFunction) {
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
        instance_id: instanceId,
      };
      console.info(`[OPENBOT:TENANT] resolved instance=${instanceId} by_receiver=${maskPhone(receiverPhone)}`);
    }
    return next();
  } catch (error: any) {
    console.warn("[OPENBOT:TENANT:RESOLVE:FAIL]", error?.message || error);
    void notifyAllDevelopersSystemFailure(error, {
      scope: "tenant_resolution",
      customerPhone: maskPhone(getReceiverPhone(body)),
    }).catch(() => undefined);
    return next();
  }
}

async function verifySecret(req: any, res: any, next: any) {
  const expected = process.env.OPENBOT_WEBHOOK_SECRET;
  const got =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.headers["x-api-key"] ||
    req.body?.token ||
    req.query?.token;
  if (expected && safeCompare(got, expected)) return next();

  try {
    const instanceId = getInstanceId(req.body || {});
    if (!instanceId) return res.status(401).json({ ok: false, error: "unauthorized" });
    const config = await getRestaurantConfig(instanceId);
    assertTenantSecret(req, config, "webhook");
    return next();
  } catch (error: any) {
    return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
  }
}
// Every shape the gateway can deliver, because getting this wrong is not a missed
// message but a loop: the bot answers its own outbound text, replies to that, and the
// spam counter eventually mutes the real guest for 15 minutes. extractMessageId and
// isGroupMessage both already accept a TOP-LEVEL body.key, so a payload shaped
// {key:{fromMe:true,id:...}} reached the pipeline with fromMe:false (found 2026-08-23).
function isOwnWhatsAppMessage(body: any): boolean {
  const eventData = body?.data || {};
  return (
    body?.fromMe === true ||
    body?.isFromMe === true ||
    body?.key?.fromMe === true ||
    eventData?.fromMe === true ||
    eventData?.isFromMe === true ||
    eventData?.key?.fromMe === true ||
    body?.message?.key?.fromMe === true
  );
}

function isGroupMessage(body: any): boolean {
  const eventData = body?.data || body || {};
  const key = eventData?.key || body?.key || {};
  return Boolean(
    body?.isGroup === true ||
      eventData?.isGroup === true ||
      key?.remoteJid?.endsWith?.("@g.us") ||
      key?.participant?.endsWith?.("@g.us") ||
      String(body?.sender || eventData?.sender || body?.from || eventData?.from || "").endsWith("@g.us")
  );
}

function isIncomingVoiceCall(body: any): boolean {
  // WhatsPro / Evolution-API delivers calls two ways:
  //   1. A dedicated "call" event  → body.event === "call"
  //   2. A messages.upsert where the message type is "callLogMessage"
  const event = String(body?.event || "").toLowerCase();
  if (event === "call") return true;
  const msg = body?.data?.message || body?.message || {};
  const inner = msg?.ephemeralMessage?.message || msg || {};
  if (inner?.callLogMessage) return true;
  const messageType = String(
    body?.data?.messageType || body?.messageType || body?.data?.type || body?.type || ""
  ).toLowerCase();
  return messageType === "calllogmessage" || messageType === "call";
}

function isStatusQuestion(text = ""): boolean {
  return STATUS_CONTEXT_RE.test(String(text || ""));
}

function runtimeUnavailableReply(ctx: FastFoodContext): string | null {
  if (!isStatusQuestion(ctx.text)) return null;
  if (ctx.runtimeStatus) return null;
  return ctx.language === "kk"
    ? "Қазір асүй статусын тексере алмаймын. Кейін қайталап жазыңыз."
    : "Не могу проверить статус кухни. Напишите позже.";
}

function unavailableOrderReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Не удалось получить актуальный статус заказа. Попробуйте немного позже."
    : "Тапсырыстың өзекті статусын ала алмадым. Сәл кейінірек қайталап көріңіз.";
}

function missingOrderReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Активный заказ по этому номеру не найден. Отправьте номер заказа."
    : "Бұл нөмір бойынша белсенді тапсырыс табылмады. Тапсырыс нөмірін жіберіңіз.";
}

// The guest already wrote "№13". Asking them to "send the order number" reads as
// if we did not read their message. Name the number back, say plainly that it is
// not on this phone, and give the two ways forward.
function missingQuotedOrderReply(language: "kk" | "ru", orderNumber: string) {
  return language === "ru"
    ? `Заказ №${orderNumber} по этому номеру не найден. Если он оформлен с другого номера — напишите с него, либо я передам оператору.`
    : `№${orderNumber} тапсырысы осы нөмір бойынша табылмады. Басқа нөмірмен жасалған болса, сол нөмірден жазыңыз — немесе операторға жалғастырамын.`;
}

// The bot may never change order state, so a cancellation request is answered by
// saying exactly that and handing it to a human - never by asking for an order
// number the guest cannot use for anything.
function cancellationHandoffReply(ctx: FastFoodContext, orderNumber = ""): string {
  const number = String(
    orderNumber || ctx.activeOrder?.order_number || ctx.activeOrder?.order_id || ctx.activeOrder?.id || "",
  ).replace(/\D/g, "");
  const label = number ? (ctx.language === "ru" ? `Заказ №${number}: ` : `№${number} тапсырысы: `) : "";
  return ctx.language === "ru"
    ? `${label}отменить заказ сам я не могу — уже передал оператору, он свяжется с вами и оформит отмену. Ничего больше делать не нужно.`
    : `${label}тапсырысты өзім жоя алмаймын — операторға дереу бердім, ол сізбен байланысып бас тартуды рәсімдейді. Басқа ештеңе жасау қажет емес.`;
}

// There is nothing to cancel until an order exists. Saying so plainly - and
// offering the operator instead of demanding a number - is the honest answer;
// raising an operator case for an order nobody placed wastes a human's time
// (user correction, 2026-08-12).
function nothingToCancelReply(ctx: FastFoodContext): string {
  return ctx.language === "ru"
    ? "Проверил: активного заказа на этом номере нет, отменять пока нечего. Если заказ оформлен с другого номера — напишите с него, а если нужен оператор, скажите, и я сразу передам."
    : "Тексердім: осы нөмірде белсенді тапсырыс жоқ, сондықтан бас тартатын ештеңе жоқ. Тапсырыс басқа нөмірмен жасалған болса, сол нөмірден жазыңыз; оператор керек болса айтыңыз, дереу жалғастырамын.";
}

// A guest who asks a second time is not going to accept "there is no order".
function repeatedCancellationRequest(history: unknown): boolean {
  if (!Array.isArray(history)) return false;
  let seen = 0;
  for (let index = history.length - 1; index >= 0 && seen < 8; index -= 1) {
    const entry: any = history[index];
    const role = String(entry?.role || "").toLowerCase();
    if (role !== "user") continue;
    seen += 1;
    if (isOrderCancellationRequest(String(entry?.text || entry?.content || ""))) return true;
  }
  return false;
}

// The wait the kitchen entered for this turn, so a status answer can name it.
function ctxKitchenWaitMinutes(ctx: FastFoodContext): number {
  const live: any = ctx.hardRealtimeContext || {};
  const runtime: any = ctx.runtimeStatus || {};
  const value = Number(live.wait_time ?? runtime.wait_time ?? runtime.kitchen_status?.wait_time ?? 0) || 0;
  return Math.max(0, Math.floor(value));
}

// What the guest actually has, resolved from the same sources as the status
// route: a number they quoted, the order under discussion, then their active
// order. The cancellation answer is decided from this, never before it.
async function resolveCancellationTarget(ctx: FastFoodContext): Promise<{
  state: "found" | "missing" | "unavailable";
  orderNumber: string;
  statusLine: string;
}> {
  const quotedNumber = requestedOrderNumber(ctx.text);
  const discussedNumber = quotedNumber ? "" : lastDiscussedOrderNumber(ctx.chatHistory);
  const discussedRecord = discussedNumber ? pickConversationOrder(ctx.activeOrder, discussedNumber) : null;
  const lookup = quotedNumber
    ? await getCustomerOrder(ctx.instanceId, String(ctx.config?.domain || ""), ctx.phone, ctx.language, quotedNumber)
    : ctx.activeOrder?.is_stale
      ? { state: "unavailable" as const }
      : customerOrderFromRecord(discussedRecord || ctx.activeOrder, ctx.phone, ctx.language);
  if (lookup.state === "found") {
    const order: any = (lookup as any).order;
    const number = String(order?.order_number || order?.order_id || order?.id || quotedNumber || "").replace(/\D/g, "");
    return { state: "found", orderNumber: number, statusLine: formatCustomerOrderStatus(order, ctx.language, ctxKitchenWaitMinutes(ctx)) };
  }
  if (lookup.state === "unavailable") return { state: "unavailable", orderNumber: quotedNumber, statusLine: "" };
  return { state: "missing", orderNumber: quotedNumber, statusLine: "" };
}


async function customerOrderReply(ctx: FastFoodContext): Promise<string | null> {
  // "заказ 59 холодный привезли" names an order, but the guest is not asking where it is —
  // they are angry about it. Answering with a status line would bury a real
  // complaint and never raise the operator flag, so anger and human requests
  // are left to the escalation path further down instead of being short-circuited here.
  if (isLikelyComplaintText(ctx.text) || isLikelyOperatorRequestText(ctx.text)) return null;
  // A timing question with no order in play at all belongs to the runtime wait
  // time, not to the status route - see isUnownedOrderTimingQuestion.
  const quotedNumber = requestedOrderNumber(ctx.text);
  const priorNumber = quotedNumber ? "" : lastDiscussedOrderNumber(ctx.chatHistory);
  if (isUnownedOrderTimingQuestion({
    text: ctx.text,
    hasActiveOrder: Boolean(ctx.activeOrder),
    quotedOrderNumber: quotedNumber,
    discussedOrderNumber: priorNumber,
  })) {
    return null;
  }
  const timingAsked = Boolean(ctx.activeOrder)
    && isOrderTimingQuestion(ctx.text)
    && !isProspectiveOrderTimingQuestion(ctx.text);
  if (!isCustomerOrderStatusQuestion(ctx.text) && !(ctx.activeOrder && isLikelyOrderStatusFollowUp(ctx.text)) && !timingAsked) return null;
  const orderNumber = quotedNumber;
  const discussedNumber = priorNumber;
  const discussedRecord = discussedNumber ? pickConversationOrder(ctx.activeOrder, discussedNumber) : null;
  const lookup = orderNumber
    ? await getCustomerOrder(ctx.instanceId, String(ctx.config?.domain || ""), ctx.phone, ctx.language, orderNumber)
    : ctx.activeOrder?.is_stale
      ? { state: "unavailable" as const }
      : customerOrderFromRecord(discussedRecord || ctx.activeOrder, ctx.phone, ctx.language);
  if (lookup.state === "found") return formatCustomerOrderStatus(lookup.order, ctx.language, ctxKitchenWaitMinutes(ctx));
  if (lookup.state === "unavailable") return unavailableOrderReply(ctx.language);
  // Only a number backed by a real record may be named back to the guest. A
  // number that merely appeared in the conversation, with nothing behind it, used
  // to produce "№019 not found" for a guest who never had order 019.
  const referenced = orderNumber || (discussedRecord ? discussedNumber : "");
  return referenced ? missingQuotedOrderReply(ctx.language, referenced) : missingOrderReply(ctx.language);
}

function operationalPreemptionReply(ctx: FastFoodContext): string | null {
  // Same reason as the kitchen gate above: this runs before the cancellation and
  // complaint lanes and returns unconditionally. "Ақшамды аудардым, бірақ
  // тапсырыс келмеді, оператор керек" was answered with "send the receipt" and
  // the human request was never escalated (found 2026-08-22).
  if (isLikelyComplaintText(ctx.text) || isLikelyOperatorRequestText(ctx.text)) return null;
  // A text claim is not proof of payment. Asking for the receipt here avoids an
  // unnecessary model call and, critically, cannot mutate the order to paid or
  // accidentally send the menu link again.
  if (!ctx.mediaContext && isUnverifiedPaymentClaim(ctx.text)) {
    return buildUnverifiedPaymentClaimReply(ctx.language);
  }

  // Active operator notes outrank the ordering/link intent. This deterministic
  // check covers compound phrases such as "is Futomaki available, can I order?"
  // where the link tool previously hid the unavailable-item warning.
  const blockedItem = findBlockedMenuItemMention(
    ctx.activeShiftNotes,
    Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [],
    ctx.text,
  );
  return blockedItem ? buildBlockedMenuItemReply(blockedItem, ctx.language) : null;
}

// busyKitchenReply used to hard-code the "we are busy, do you agree to wait?"
// sentence, but nothing has called it since the busy kitchen became a context
// fact (operational_runtime.wait_consent_required + wait_label) that the agent
// phrases itself in its own words. Removed so there is exactly one owner of
// that message and no dead template can silently come back.
// The hub tells us WHY it is closed and we used to throw that away, answering every state
// with "по важной технической причине" - untrue for all of them except an emergency stop,
// and it leaves the guest with nothing to do. It also lands hardest exactly where it is
// least appropriate: a newly onboarded restaurant has its service channels switched off,
// so its first guests were told the bot was broken (found 2026-08-23, live on kebab1).
//
// "Technical" is now reserved for the one case where it is honest.
function busyKitchenReply(policy: KitchenSalesPolicy, language: "kk" | "ru", channel: "delivery" | "pickup" | "unknown" = "unknown") {
  const label = channel === "delivery"
    ? (language === "ru" ? policy.deliveryWaitLabelRu : policy.deliveryWaitLabelKk)
    : channel === "pickup"
      ? (language === "ru" ? policy.pickupWaitLabelRu : policy.pickupWaitLabelKk)
      : (language === "ru" ? policy.waitLabelRu : policy.waitLabelKk);
  const subject = channel === "delivery"
    ? (language === "ru" ? "доставка" : "жеткізу")
    : channel === "pickup"
      ? (language === "ru" ? "самовывоз" : "алып кету")
      : (language === "ru" ? "приготовление" : "дайындау");
  return language === "ru"
    ? `Сейчас у нас много заказов, поэтому ${subject} может занять примерно ${label}.\nСможете подождать? Если да — сразу продолжим ваш заказ.`
    : `Қазір тапсырыс көп болып жатыр, сондықтан ${subject} шамамен ${label} уақыт алуы мүмкін.\nКүте аласыз ба? Иә десеңіз, тапсырысыңызды бірден жалғастырамыз.`;
}

function chooseServiceChannelReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Подскажите, пожалуйста: вам удобнее доставка или самовывоз? Так я сразу скажу точное время по вашему варианту."
    : "Айтыңызшы: жеткізу қолайлы ма, әлде өзіңіз алып кетесіз бе? Сол бойынша нақты уақытты бірден айтамын.";
}

function ambiguousConsentReply(language: "kk" | "ru") {
  return language === "ru"
    ? "Извините, не до конца понял вас. Такое ожидание вам подходит — да или нет?"
    : "Кешіріңіз, сізді толық түсінбедім. Осындай күту уақыты сізге қолайлы ма — иә немесе жоқ?";
}

function closedKitchenReply(policy: KitchenSalesPolicy, language: "kk" | "ru") {
  const reason = String(policy.closedReason || "").toLowerCase();
  const channelsOff = reason.includes("service_channels_disabled") || (!policy.delivery && !policy.pickup);
  const emergency = policy.isEmergency || reason.includes("emergency");

  if (language === "ru") {
    if (policy.mode === "vacation") return `Сейчас временно не принимаем заказы${policy.remainingDays ? ` примерно ${policy.remainingDays} дн.` : ""}. Напишите нам немного позже — мы сообщим актуальную информацию. Спасибо за понимание.`;
    // Closed for the night is not a breakdown: saying "по технической причине"
    // here made a normal closing time sound like a failure and left the guest
    // with nothing to do about it.
    if (policy.mode === "off_hours") return "Сейчас мы закрыты — заказы принимаем в рабочие часы. Напишите, как только откроемся, и я всё оформлю. Меню можно посмотреть уже сейчас.";
    // Both fulfillment channels are switched off. Nothing is broken and the guest can
    // still be useful to: the menu is readable and we will write when it reopens.
    if (channelsOff && !emergency) return "Сейчас ни доставка, ни самовывоз не доступны, поэтому заказ пока оформить не получится. Меню можно посмотреть уже сейчас — напишите позже, и я всё оформлю.";
    if (emergency) return "Кухня временно остановлена, заказы сейчас не принимаем. Напишите нам немного позже, пожалуйста — как только возобновим, всё оформлю.";
    return "Сейчас заказы временно не принимаем. Пожалуйста, напишите нам немного позже — я сразу всё оформлю. Меню можно посмотреть уже сейчас.";
  }
  if (policy.mode === "vacation") return `Қазір уақытша тапсырыс қабылдамаймыз${policy.remainingDays ? `, шамамен ${policy.remainingDays} күн` : ""}. Біраздан кейін қайта жазып, өзекті жағдайды нақтылап көріңіз. Түсіністік танытқаныңызға рақмет.`;
  if (policy.mode === "off_hours") return "Қазір жабықпыз — тапсырыстарды жұмыс уақытында қабылдаймыз. Ашылған кезде жазсаңыз, бәрін рәсімдеп беремін. Мәзірді қазірдің өзінде қарап отыруға болады.";
  if (channelsOff && !emergency) return "Қазір жеткізу де, алып кету де қолжетімсіз, сондықтан тапсырысты әзірге рәсімдей алмаймын. Мәзірді қазірдің өзінде қарап отыруға болады — кейінірек жазсаңыз, бәрін рәсімдеп беремін.";
  if (emergency) return "Асүй уақытша тоқтатылды, қазір тапсырыс қабылдамаймыз. Біраздан кейін жазыңызшы — қайта іске қосылған бойда бәрін рәсімдеп беремін.";
  return "Қазір тапсырысты уақытша қабылдамаймыз. Біраздан кейін жазсаңыз, бәрін бірден рәсімдеп беремін. Мәзірді қазірдің өзінде қарап отыруға болады.";
}
function unavailableChannelReply(channel: "delivery" | "pickup", language: "kk" | "ru") {
  if (language === "ru") return channel === "delivery" ? "Сейчас доставка временно недоступна, но можно оформить самовывоз." : "Сейчас самовывоз временно недоступен, но можно оформить доставку.";
  return channel === "delivery" ? "Қазір жеткізу уақытша қолжетімсіз, бірақ алып кетуге тапсырыс бере аласыз." : "Қазір алып кету уақытша қолжетімсіз, бірақ жеткізуге тапсырыс бере аласыз.";
}
function missedCallReply(language: "kk" | "ru", brandName?: string): string {
  if (language === "ru") {
    const intro = brandName ? `помощник ${brandName}` : "ваш помощник";
    return `Здравствуйте! К сожалению, не можем ответить на звонок. Я — ${intro} 😊 Чем могу помочь? Напишите — слушаю вас!`;
  }
  const intro = brandName ? `${brandName} көмекшісімін` : "сіздің көмекшіңізбін";
  return `Сәлеметсізбе! Қоңырауға жауап бере алмаймыз. Мен — ${intro} 😊 Қандай сұрағыңыз бар? Жазыңыз, сізге көмектесуге дайынмын!`;
}
type DeferredKitchenConsent = { deferredMenuLinkIntent?: boolean };
type DeferredKitchenConsentDeps = {
  issueAccessLink: typeof issueCustomerAccessLink;
  markLinkSent: typeof markMagicLinkSent;
  upsertLead: typeof upsertCustomerLead;
};

const deferredKitchenConsentDeps: DeferredKitchenConsentDeps = {
  issueAccessLink: issueCustomerAccessLink,
  markLinkSent: markMagicLinkSent,
  upsertLead: upsertCustomerLead,
};

export async function resumeDeferredKitchenConsent(
  ctx: FastFoodContext,
  pending: DeferredKitchenConsent,
  deps: DeferredKitchenConsentDeps = deferredKitchenConsentDeps,
): Promise<string | null> {
  // Records written before deferredMenuLinkIntent existed contain only the
  // policy fingerprint. A positive answer still means "continue the order":
  // the question itself explicitly promised that continuation, so legacy and
  // current consent records must behave identically.
  void pending;

  const link = await deps.issueAccessLink({
    instanceId: ctx.instanceId,
    phone: ctx.phone,
    locale: ctx.language,
    config: ctx.config || {},
  }).catch(() => null);

  if (!link) {
    ctx.magicLink = null;
    ctx.magicLinkFailed = true;
    ctx.magicLinkGranted = false;
    return ctx.language === "ru"
      ? "Спасибо, что подтвердили! Меню сейчас подготовить не получилось — техническая заминка. Напишите ещё раз через пару минут, и я сразу всё пришлю."
      : "Растағаныңызға рақмет! Мәзірді дәл қазір дайындай алмадым — шағын техникалық ақаулық. Бірер минуттан кейін жазсаңыз, бірден жіберемін.";
  }

  ctx.magicLink = link;
  ctx.magicLinkFailed = false;
  ctx.magicLinkGranted = true;
  await deps.markLinkSent(ctx.instanceId, ctx.phone).catch(() => false);
  await deps.upsertLead({ instanceId: ctx.instanceId, phone: ctx.phone, config: ctx.config || {} }).catch(() => false);
  return ctx.language === "ru"
    ? "Отлично, спасибо за ожидание! 🙌 Это ваше меню — заходите и оформляйте заказ.\nЕсли будут вопросы, спрашивайте, не стесняйтесь!"
    : "Жақсы, күткеніңізге рақмет! 🙌 Бұл — сіздің мәзіріңіз, кіріп тапсырыс бере аласыз.\nҚосымша сұрағыңыз болса, қысылмай жазыңыз!";
}

async function kitchenGateReply(ctx: FastFoodContext): Promise<string | null> {
  // A complaint, a request for a person, or a cancellation is not new ordering
  // intent, and this gate returns unconditionally once the kitchen is closed or
  // busy - before the agent and before the post-agent escalation gate. So a real
  // complaint arriving after closing time was answered with opening hours and
  // produced no case, no panel SOS and no hub signal: a silent drop of exactly
  // the class the escalation contract calls worse than a double (found
  // 2026-08-22). customerOrderReply already has this guard at line 393; the
  // kitchen gate did not. Complaints about late or cold delivery typically arrive
  // near closing time.
  if (isLikelyComplaintText(ctx.text) || isLikelyOperatorRequestText(ctx.text) || isOrderCancellationRequest(ctx.text)) {
    return null;
  }
  // An existing order does not silence the kitchen. Questions ABOUT that order
  // are already answered above by customerOrderReply, so anything reaching here
  // is new intent, and new intent must hear the kitchen's real state. Repetition
  // is prevented by consent memory below, not by muting the gate.
  const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus, ctx.activeShiftNotes);
  // kitchen is what it was when they got it. A real change reopens the gate.
  const pending = await getPendingKitchenConsent(ctx.instanceId, ctx.phone).catch(() => null);
  const requestedChannel = detectRequestedServiceChannel(ctx.text);
  if (pending) {
    if (pending.policyFingerprint !== policy.fingerprint) {
      await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
    } else if (pending.kind === "channel" && pending.channel === "unknown") {
      if (requestedChannel === "unknown") return chooseServiceChannelReply(ctx.language);
      const channelPolicy = consentRequirement(policy, requestedChannel);
      if (channelPolicy.kind === "delay") {
        await savePendingKitchenConsent(ctx.instanceId, ctx.phone, policy.fingerprint, "delay", pending.deferredMenuLinkIntent, requestedChannel);
        return busyKitchenReply(policy, ctx.language, requestedChannel);
      }
      await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
      return null;
    } else {
      const answer = detectKitchenConsentAnswer(ctx.text);
      if (answer === "yes") {
        await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
        // The guest accepted this exact kitchen state. Remember it, so the wait
        // is raised once and never turns into nagging on every message.
        await markKitchenCheckoutStarted(ctx.instanceId, ctx.phone, policy.fingerprint).catch(() => false);
        const continuation = await resumeDeferredKitchenConsent(ctx, pending);
        if (continuation) return continuation;
        return null;
      }
      if (answer === "no") {
        await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
        return ctx.language === "ru"
          ? "Конечно, понимаю — извините, что так долго.\nТогда сейчас заказ оформлять не будем. Заходите к нам чуть позже, всегда будем рады!"
          : "Әрине, түсінемін — күттіретініміз үшін кешіріңіз.\nОнда қазір тапсырысты рәсімдемей тұрайық. Кейінірек жазсаңыз, әрқашан қуана қабылдаймыз!";
      }
      // Consent is mandatory. Never let an unrelated or ambiguous answer fall
      // through to the model, which used to interpret it as agreement.
      return ambiguousConsentReply(ctx.language);
    }
  }
  if (policy.blocksAllSales) return closedKitchenReply(policy, ctx.language);
  if (requestedChannel === "delivery" && !policy.delivery) return unavailableChannelReply(requestedChannel, ctx.language);
  if (requestedChannel === "pickup" && !policy.pickup) return unavailableChannelReply(requestedChannel, ctx.language);
  // A guest who already accepted this same kitchen state is left to finish.
  const checkoutFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
  if (checkoutFingerprint && checkoutFingerprint === policy.fingerprint) return null;

  const requirement = consentRequirement(policy, requestedChannel);
  if (requirement.kind === "channel" && requestedChannel === "unknown") {
    await savePendingKitchenConsent(ctx.instanceId, ctx.phone, policy.fingerprint, "channel", ctx.explicitMenuLinkIntent, "unknown");
    return chooseServiceChannelReply(ctx.language);
  }
  if (requirement.kind === "delay") {
    const channel = requestedChannel === "unknown" ? "unknown" : requestedChannel;
    await savePendingKitchenConsent(ctx.instanceId, ctx.phone, policy.fingerprint, "delay", ctx.explicitMenuLinkIntent, channel);
    return busyKitchenReply(policy, ctx.language, channel);
  }
  return null;
}

// "Тапсырыс дайын болуы қанша минут?" from a guest with no order is a question
// about the kitchen, and the kitchen's answer is a number the code holds. Left to
// the model it replied with the menu link - a real answer to a different
// question (live round, 2026-08-11). The busy and closed states are already
// answered by kitchenGateReply above, so this only speaks for a working kitchen.
function prepTimeReply(ctx: FastFoodContext): string | null {
  if (!isUnownedOrderTimingQuestion({
    text: ctx.text,
    hasActiveOrder: Boolean(ctx.activeOrder),
    quotedOrderNumber: requestedOrderNumber(ctx.text),
    discussedOrderNumber: lastDiscussedOrderNumber(ctx.chatHistory),
  })) return null;
  // A mixed message ("суши қанша тұрады, қанша уақытта жетеді?") needs the menu
  // too, so it stays with the model rather than getting half an answer here.
  if (hasMenuBrowsingIntent(ctx.text)) return null;
  // Without a live kitchen state there is no number to give; the runtime
  // fallback reply further down says that honestly.
  if (!ctx.runtimeStatus) return null;
  const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus, ctx.activeShiftNotes);
  const language = ctx.language === "ru" ? "ru" : "kk";
  if (policy.waitMinutes > 0) {
    const label = formatKitchenWait(policy.waitMinutes, language);
    return language === "ru"
      ? `Сейчас приготовление занимает примерно ${label}. Оформим заказ — сразу напишем точное время.`
      : `Қазір дайындау шамамен ${label} алады. Тапсырыс рәсімделген соң нақты уақытты бірден жазамыз.`;
  }
  return language === "ru"
    ? "Кухня работает в обычном режиме — готовим без задержек. Как только оформите заказ, сразу напишем точное время."
    : "Асүй қалыпты режимде жұмыс істеп жатыр — кешіктірмей дайындаймыз. Тапсырыс рәсімделген соң нақты уақытты бірден жазамыз.";
}

function hasMeaningfulMediaDescription(text = "", mediaContext: Record<string, any> | null = null) {
  const clean = stripEscalationSignals(text).trim();
  if (!clean || clean === "[Media sent]") return false;
  const historyLabel = String(mediaContext?.historyLabel || "").trim();
  if (historyLabel && clean === historyLabel) return false;
  return clean.length >= 2;
}

async function sendCustomerReplyAndFinish(ctx: FastFoodContext, messageId: string, reply: string, source: string) {
  const cleanReply = stripEscalationSignals(reply);
  if (cleanReply) {
    const delivery = await sendWhatsProResponseSequence({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      text: cleanReply,
      requestScope: messageId,
      pace: resolvePaceUrgency(ctx),
    });
    if (!delivery.ok) throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", cleanReply, { source, ...noteHistoryMeta(ctx, cleanReply) });
  }
  if (ctx.magicLinkGranted && ctx.magicLink) {
    const linkDelivery = await sendWhatsProResponseSequence({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      text: ctx.magicLink,
      requestScope: `${messageId}:magic-link`,
    }).catch(() => null);
    if (linkDelivery?.ok) {
      await saveToHistory(ctx.instanceId, ctx.phone, "assistant", ctx.magicLink, { source: "openbot-agent" });
    } else {
      console.warn(`[OPENBOT:OUTBOUND] deferred magic link send failed instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)}`);
    }
  }
  await markInboundDone(ctx.instanceId, messageId);
  await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch(() => false);
}

async function processWhatsAppWebhook(body: any, started: number) {
  const instanceId = getInstanceId(body);
  const phone = getPhone(body);
  // Reassigned once the guard reports the id it deduped on (see below).
  let messageId = extractMessageId(body);
  let mediaContext = extractInboundMedia(body);
  const senderMeta = extractSenderMeta(body);
  let text =
    extractInboundText(body) ||
    mediaContext?.caption ||
    mediaContext?.historyLabel ||
    (mediaContext ? "[Media sent]" : "");
  let customerLanguageText = extractInboundText(body) || mediaContext?.caption || "";
  let stopTyping: () => void = () => {};
  let turnLockOwner: string | null = null;

  console.log(
    `[OPENBOT:INBOUND] received instance=${instanceId || "-"} phone=${maskPhone(phone)} text_len=${String(text || "").length} media=${mediaContext?.kind || "no"} source=${body.source || "-"}`
  );

  try {
    if (!String(text || "").trim() && !mediaContext) {
      if (isIncomingVoiceCall(body) && instanceId && phone) {
        // Someone rang the bot's WhatsApp number. Reply with a text redirect
        // so the customer knows to write instead of call.
        if (runtimeTestModeEnabled()) {
          const devPhone = String(
            getRuntimeSettings()?.developerPhone || process.env.OPENBOT_DEVELOPER_PHONE || ""
          ).replace(/\D/g, "");
          if (devPhone && phone !== devPhone) {
            return; // test_mode: only handle developer_phone calls
          }
        }
        const callConfig = await getRestaurantConfig(instanceId).catch(() => null);
        // callsDisabled=false means the admin re-enabled live calls (future voice assistant).
        // Default (undefined/true) keeps the text-redirect behaviour that was already deployed.
        const callsDisabled = (callConfig as any)?.callsDisabled ?? (callConfig as any)?.calls_disabled;
        if (callsDisabled === false) {
          console.log(
            `[OPENBOT:CALL] calls_enabled_passthrough instance=${instanceId} phone=${maskPhone(phone)}`
          );
          return; // admin enabled live calls — let WhatsApp ring through, no text redirect
        }
        const callLang = (["ru", "russian"].includes(
          String((callConfig as any)?.language || "").toLowerCase()
        ) ? "ru" : "kk") as "kk" | "ru";
        const callBrand = String((callConfig as any)?.brand || "").trim() || undefined;
        await sendWhatsProResponseSequence({
          instanceId,
          phone,
          text: missedCallReply(callLang, callBrand),
          requestScope: messageId || `call:${phone}:${Date.now()}`,
        }).catch((err: any) =>
          console.warn(`[OPENBOT:CALL] reply_failed instance=${instanceId} phone=${maskPhone(phone)}`, err?.message || err)
        );
        console.log(
          `[OPENBOT:CALL] missed_call_replied instance=${instanceId} phone=${maskPhone(phone)} lang=${callLang} elapsed=${Date.now() - started}ms`
        );
      } else {
        console.log(
          `[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=empty_message elapsed=${Date.now() - started}ms`
        );
      }
      return;
    }

    if (!instanceId) {
      // An unresolved tenant used to fall into the bot_paused branch below and vanish with a
      // misleading log line. A message from a real number that no tenant claims means either
      // a misconfigured gateway or a new tenant whose config has not landed yet - both need a
      // human, so say so once (found 2026-08-23).
      console.warn(
        `[OPENBOT:TENANT:UNRESOLVED] message discarded receiver=${maskPhone(phone)} messageId=${messageId} hint="no tenant config matches this WhatsApp number; check the tenants platform"`
      );
      void notifyDeveloperSystemFailure(
        String(process.env.OPENBOT_DEFAULT_INSTANCE || ""),
        new Error("TENANT_UNRESOLVED_FOR_INBOUND"),
        { scope: "tenant_resolution", messageId, customerPhone: maskPhone(phone) },
      ).catch(() => undefined);
      return;
    }

    if (!(await isTenantBotEnabled(instanceId))) {
      await markInboundDone(instanceId, messageId).catch(() => undefined);
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=bot_paused elapsed=${Date.now() - started}ms`
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
      senderMeta,
    });
    // From here on the turn is identified by the id the guard actually deduped on. For a
    // payload the gateway sent without one that is a derived hash, and marking the empty
    // raw id instead would leave a 180s processing lock nobody releases (found 2026-08-23).
    if (guard.dedupeId) messageId = guard.dedupeId;
    if (guard.blocked) {
      if (guard.source === "operator_override") {
        await saveToHistory(String(instanceId || ""), String(phone || ""), "user", text || mediaContext?.historyLabel || "[operator override]", {
          source: "operator_override",
          media: safeMediaMetadata(mediaContext),
        });
      }
      // A contact-policy skip used to print only its verdict, so telling "this guest is
      // genuinely not in the book" apart from "we could not read the book at all" meant
      // reasoning from source instead of reading the log (owner incident, 2026-08-30).
      const contactTrace = guard.reason === "unsaved_contact_policy" || guard.reason === "private_saved_contact"
        ? ` saved=${senderMeta.isMyContact ? "yes" : "no"} book=${senderMeta.addressBookKnown ? "known" : "unknown"}`
        : "";
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=${guard.reason || "blocked"}${contactTrace} elapsed=${Date.now() - started}ms`
      );
      return;
    }

    // Presence + read receipt start the moment the guard accepts the
    // message: the customer sees blue ticks and "typing..." for the whole
    // turn, including the buffer wait that used to look like dead silence.
    stopTyping = startWhatsProTyping({ instanceId, phone });
    void markWhatsProChatRead({ instanceId, phone });

    // Stickers are accepted by the gateway, but never sent to AI or persisted.
    if (mediaContext?.kind === "sticker") {
      await markInboundDone(instanceId, messageId);
      return;
    }

    // One conversation = one reply at a time. Waits a bounded moment for a turn that is
    // already running, exactly as the text lane always did - factored out because the media
    // lane needs the same protection and had none (see below).
    const waitForTurnLock = async () => {
      let owner = await acquireTurnLock(instanceId, phone);
      for (let waited = 0; !owner && waited < 45_000; waited += 1_500) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        owner = await acquireTurnLock(instanceId, phone);
      }
      return owner;
    };

    // Merge fragmented text messages in a small, short-lived Redis buffer.
    if (!mediaContext && text) {
      const buffered = await bufferInboundText({ instanceId, phone, messageId, text });
      if (!buffered.leader) {
        await markInboundDone(instanceId, messageId);
        return;
      }

      // The per-message lock never stopped two batches of split messages from being
      // answered in parallel; this turn lock does. A part that arrives while the previous
      // reply is still being generated waits a bounded moment, then gets folded into ONE
      // coherent message by the buffer brain - never a second answer.
      turnLockOwner = await waitForTurnLock();
      if (!turnLockOwner) {
        // Waiting out the previous turn is preferable to answering twice, but a
        // guest message must never be thrown away: it goes back into the buffer
        // so the turn that is finishing folds it into its own answer.
        console.warn(`[OPENBOT:BUFFER] turn busy, part requeued instance=${instanceId} phone=${maskPhone(phone)}`);
        await requeueInboundText({ instanceId, phone, messageId, text }).catch(() => undefined);
        await markInboundDone(instanceId, messageId);
        return;
        // NOTE: requeueInboundText now also arms inbound_buffer_latest, so the next
        // message from this guest becomes a leader that picks this part up. Before, the
        // part sat in a list nobody was waiting on and the finishing turn deleted it.
      }
      const leftovers = await drainInboundBuffer(instanceId, phone).catch(() => [] as string[]);
      const parts = [...buffered.items, ...leftovers].filter(Boolean);
      text = parts.length > 1
        ? await mergeBufferedParts(parts).catch(() => buffered.text || text)
        : (parts[0] || buffered.text || text);
      customerLanguageText = text;
    }

    // A media turn took NO turn lock at all: the acquisition above sits inside
    // `if (!mediaContext && text)`. Everything from here on is shared with the text lane -
    // preloadContext, media analysis, the receipt lane, the agent, the send sequence - so a
    // guest who sent a photo and then typed had two turns running over one conversation,
    // two replies, and in the receipt lane two analyses of the same payment (found
    // 2026-08-23).
    //
    // It is taken here rather than inside the block above because a photo must not go
    // through bufferInboundText - that buffer merges text fragments and a photo is not a
    // fragment.
    if (!turnLockOwner) {
      turnLockOwner = await waitForTurnLock();
      if (!turnLockOwner) {
        // Deliberately NOT requeued as a text part: a photo is not a fragment, and dropping
        // a paid receipt because a text turn was busy would be worse than a rare double.
        // The receipt lane has its own fingerprint claim for that. Proceeding unlocked is
        // the same behaviour this lane has always had, now logged instead of silent.
        console.warn(
          `[OPENBOT:TURN] media turn proceeding without the lock instance=${instanceId} phone=${maskPhone(phone)} kind=${mediaContext?.kind || "-"}`
        );
      }
    }

    mediaContext = await hydrateInboundMedia(body, mediaContext);
    const ctx = await preloadContext({ instanceId, phone, text, languageCandidateText: customerLanguageText, mediaContext, senderMeta });
    console.log(
      `[OPENBOT:CONTEXT] loaded instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} lang=${ctx.language} domain=${ctx.config?.domain || "-"} runtime=${ctx.runtimeStatus ? "ok" : "missing"} wait=${ctx.hardRealtimeContext.wait_time ?? "-"} order=${ctx.activeOrder?.order_id || "none"} notes=${ctx.activeShiftNotes.length} history=${ctx.chatHistory.length} link_sent=${ctx.magicLinkAlreadySent}`
    );

    // Every early exit below - video, a file we cannot read, a rejected or
    // duplicate receipt - used to return before the inbound message was written
    // to history, so the next turn saw our own refusal with nothing before it and
    // the guest had to explain themselves twice. The turn is recorded once, here,
    // whatever happens to it afterwards.
    let inboundRecorded = false;
    const recordInboundTurn = async () => {
      if (inboundRecorded) return;
      inboundRecorded = true;
      await saveToHistory(ctx.instanceId, ctx.phone, "user", ctx.text, {
        source: "openbot-agent",
        media: safeMediaMetadata(mediaContext),
      });
    };
    await recordInboundTurn();

    if (mediaContext?.kind === "video") {
      const reply =
        ctx.language === "ru"
          ? "Извините, я не принимаю видео. Пожалуйста, опишите, что произошло, текстом или отправьте фото."
          : "Кешіріңіз, видео қабылдай алмаймын. Не болғанын мәтінмен түсіндіріңіз немесе фото жіберіңіз.";
      // Sent through the same helper as every other reply, so the refusal is in
      // history too and a waiting operator case still gets its signal bumped.
      await sendCustomerReplyAndFinish(ctx, messageId, reply, "media_rejected:video");
      return;
    }

    if (mediaContext && !mediaContext.valid) {
      if (mediaContext.reason === "voice_too_long") {
        const routing = await routeComplaintToAdmin(ctx, {
          summary: `Клиент ұзақ дауыстық хабарлама жіберді (${mediaContext.durationSeconds || "?"} сек). Оператордың жауабы қажет.`,
          customerText: text,
          customerReply: "",
          urgency: "normal",
          // complaintRouting compares against "long_voice" exactly, so the longer
          // string never matched and the operator card said "complaint" for a
          // voice note (found 2026-08-22).
          source: "long_voice",
        });
        const reply = ctx.language === "ru"
          ? routing.escalationAvailable
            ? "Голосовое сообщение слишком длинное для автоматической обработки. Я передал обращение оператору."
            : "Голосовое сообщение слишком длинное. Пожалуйста, кратко опишите вопрос текстом."
          : routing.escalationAvailable
            ? "Дауыстық хабарлама автоматты өңдеуге тым ұзақ. Өтінішті операторға жібердім."
            : "Дауыстық хабарлама тым ұзақ. Мәселені мәтінмен қысқаша жазып жіберіңіз.";
        await sendCustomerReplyAndFinish(ctx, messageId, reply, "long_voice");
        return;
      }
      const reply = mediaContext.reason === "media_too_large"
        ? mediaContext.kind === "audio"
          ? ctx.language === "ru"
            ? "Аудиофайл слишком большой. Отправьте короткое голосовое сообщение или кратко напишите вопрос."
            : "Аудиофайл тым үлкен. Қысқа дауыстық хабарлама жіберіңіз немесе сұрақты мәтінмен жазыңыз."
          : ctx.language === "ru"
            ? "Файл слишком большой. Фото или документ должен быть не больше 5 МБ."
            : "Файл көлемі тым үлкен. Фото немесе құжат 5 МБ-тан аспауы керек."
        : mediaContext.reason === "music_audio_not_supported"
          ? ctx.language === "ru"
            ? "Музыку и обычные аудиофайлы не обрабатываю. Отправьте короткое голосовое сообщение или напишите текстом."
            : "Музыка мен кәдімгі аудиофайлдарды өңдей алмаймын. Қысқа дауыстық хабарлама жіберіңіз немесе мәтінмен жазыңыз."
          : mediaContext.reason === "unsupported_document" || mediaContext.reason === "unsupported_mime_type" || mediaContext.reason === "unsupported_audio_mime"
            ? ctx.language === "ru"
              ? "Этот формат файла не поддерживается. Отправьте фото JPG/PNG/WEBP, PDF или короткое голосовое сообщение."
              : "Бұл файл форматы қолдау таппайды. JPG/PNG/WEBP фото, PDF немесе қысқа дауыстық хабарлама жіберіңіз."
            : ctx.language === "ru"
              ? "Не удалось безопасно загрузить файл. Попробуйте отправить его ещё раз или опишите вопрос текстом."
              : "Файлды қауіпсіз жүктей алмадым. Қайта жіберіңіз немесе мәселені мәтінмен жазыңыз.";
      await sendCustomerReplyAndFinish(ctx, messageId, reply, `media_rejected:${mediaContext.reason || "invalid"}`);
      return;
    }

    let mediaPreemptiveReply = "";
    let mediaPreemptiveSource = "";
    let mediaDeveloperError = "";
    let mediaDeveloperErrorIsUserInput = false;
    // Set when the file we failed to read could have been payment evidence, so the
    // failure has a second lane instead of ending at "try again later".
    let mediaUnreadableEvidence = false;
    let immediateComplaintSummary = "";
    let immediateComplaintMedia: ComplaintMediaPayload | null = null;
    let immediateComplaintUrgency: ComplaintUrgency = "normal";

    if (mediaContext?.base64 && mediaContext.valid) {
      if (!(await claimMediaAiQuota(ctx.instanceId, ctx.phone))) {
        const reply = ctx.language === "ru"
          ? "Слишком много медиафайлов за короткое время. Подождите несколько минут и попробуйте снова."
          : "Қысқа уақытта медиафайл тым көп жіберілді. Бірнеше минут күтіп, қайта көріңіз.";
        await sendCustomerReplyAndFinish(ctx, messageId, reply, "media_rate_limited");
        return;
      }
      const activeOrder = ctx.activeOrder?.order || ctx.activeOrder || {};
      const receiptContext = {
        expectedAmount: Number(ctx.activeOrder?.total_price || activeOrder.total_price || activeOrder.total || 0),
        orderCreatedAt: String(activeOrder.created_at || activeOrder.createdAt || ""),
        nowMs: Date.now(),
      };
      const recentDialog = ctx.chatHistory.slice(-4).map((entry: any) => `${entry?.role || "user"}: ${String(entry?.text || "").slice(0, 300)}`).join("\n");
      const mediaAnalysis = await analyzeMedia(
        mediaContext.base64,
        mediaContext.mimeType || mediaContext.mediaType || "application/octet-stream",
        `${text}\n\n[RECENT DIALOGUE FOR CONTEXT ONLY]\n${recentDialog}`.slice(0, 1800),
        ctx.language,
        (mediaContext.mimeType || "").includes("pdf"),
        "",
        receiptContext
      );
      if (mediaAnalysis) {
        mediaContext = { ...mediaContext, analysis: mediaAnalysis };
        ctx.mediaContext = mediaContext;
        // The receipt is always genuinely analyzed - in test mode too. A random
        // photo must not be treated as a receipt just because the filter is off;
        // only the blocking gates (validation, duplicates, order lookup) relax.
        const strictFilter = receiptFilterEnabled();
        const aiOrderReference = String(mediaAnalysis.order_id || "").trim();
        if (mediaAnalysis.type === "receipt") {
          const validation = validateReceiptAnalysis(mediaAnalysis, receiptContext);
          // A short payment is not a fake receipt: it still goes to the operator
          // with an SOS note, and the guest is told exactly how much is left to
          // pay and to which requisites.
          const isShortfall = strictFilter && !validation.valid && validation.reason === "amount_short";
          if (strictFilter && !validation.valid && !isShortfall) {
            await sendCustomerReplyAndFinish(
              ctx,
              messageId,
              rejectedReceiptReply(ctx.language, validation.reason),
              `payment_receipt_rejected:${validation.reason}`
            );
            return;
          }

          const fingerprint = createReceiptFingerprint(String(mediaContext.base64 || ""), mediaAnalysis);
          // A resend only blocks in strict mode - in test mode sending the same
          // receipt again is expected and must go through.
          // An unreadable claim must never be read as "the guest is repeating themselves":
          // that is the accusation this whole branch exists to avoid making wrongly. When
          // the claim state is unknown the receipt is processed, which risks a duplicate
          // analysis instead of losing a real payment (found 2026-08-23).
          const fingerprintClaim = await claimReceiptFingerprint(ctx.instanceId, fingerprint);
          if (fingerprintClaim === false && strictFilter) {
            // Why this is not simply "duplicate": the acknowledgement is sent AFTER the
            // receipt has already reached the operator, and if that send fails
            // sendCustomerReplyAndFinish throws before its own markInboundDone - so the
            // lock is released, msg_done is never set, and the fingerprint stays claimed.
            // The guest, who saw no confirmation, sends the receipt again and was told
            // "do not send one receipt twice": accused of spamming a receipt they were
            // never confirmed for, after their money had already left (found 2026-08-23).
            //
            // receipt_seen on the order is the discriminator. It is written only once the
            // receipt actually reached the operator card, so a claimed fingerprint plus a
            // seen receipt means WE went quiet, not that the guest repeated themselves.
            const priorOrderNumber = String(
              activeOrder.display_number || activeOrder.order_number || activeOrder.id || activeOrder.order_id || ""
            );
            const alreadyWithOperator = priorOrderNumber
              ? await hasReceiptSeen(ctx.instanceId, priorOrderNumber).catch(() => false)
              : false;
            const duplicateReply = alreadyWithOperator
              ? ctx.language === "ru"
                ? "🧾 Ваш чек у оператора, он на проверке — отправлять ещё раз не нужно. Извините, что подтверждение не дошло сразу."
                : "🧾 Чегіңіз операторда, тексеруде — қайта жіберудің қажеті жоқ. Растауы бірден жетпегені үшін кешіріңіз."
              : ctx.language === "ru"
                ? "Этот чек уже был отправлен. Пожалуйста, не отправляйте один чек повторно."
                : "Бұл чек бұрын жіберілген. Бір чекті қайта жібермеңіз.";
            await sendCustomerReplyAndFinish(
              ctx,
              messageId,
              duplicateReply,
              alreadyWithOperator ? "payment_receipt_confirmation_resent" : "payment_receipt_duplicate"
            );
            return;
          }

          const receiptOrderNumber = aiOrderReference && aiOrderReference !== "0"
            ? aiOrderReference
            : String(activeOrder.display_number || activeOrder.order_number || activeOrder.id || activeOrder.order_id || "");
          const receiptOrder = await getCustomerOrder(
            ctx.instanceId,
            String(ctx.config?.domain || ""),
            ctx.phone,
            ctx.language,
            receiptOrderNumber
          );
          let deliverOrderNumber = receiptOrder.state === "found" ? String(receiptOrder.order.orderId || "") : "";
          if (!deliverOrderNumber && !strictFilter) {
            // Test mode: never reject just because the hub no longer lists the
            // order (a cancelled test order) - attach to the best id we know:
            // the number the AI read from the receipt, the active order, or the
            // last cached order.
            deliverOrderNumber =
              (aiOrderReference && aiOrderReference !== "0" ? aiOrderReference : "") ||
              String(activeOrder.id || activeOrder.order_id || "") ||
              (await getLastKnownOrderId(ctx.instanceId, ctx.phone).catch(() => ""));
          }
          if (!deliverOrderNumber) {
            await releaseReceiptFingerprint(ctx.instanceId, fingerprint);
            // A guest who has actually paid must never be told their order does
            // not exist just because the hub lookup was unreachable. "unavailable"
            // means we could not read, not that there is nothing to read.
            if (receiptOrder.state === "unavailable") {
              const lookupRetryReply =
                ctx.language === "ru"
                  ? "Чек получил, но сейчас не могу проверить заказ — база временно недоступна. Отправьте чек ещё раз через пару минут, пожалуйста."
                  : "Чекті алдым, бірақ тапсырысты қазір тексере алмай тұрмын — база уақытша қолжетімсіз. Бір-екі минуттан кейін чекті қайта жіберіңізші.";
              await sendCustomerReplyAndFinish(
                ctx,
                messageId,
                lookupRetryReply,
                "payment_receipt_lookup_unavailable"
              );
              return;
            }
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
            orderNumber: deliverOrderNumber,
            config: ctx.config,
            amount: mediaAnalysis.amount,
            senderName: mediaAnalysis.sender_name,
            bankName: mediaAnalysis.bank_name,
            transactionId: mediaAnalysis.transaction_id,
            paidAt: mediaAnalysis.date_time,
            receiptBase64: String(mediaContext.base64 || ""),
            mimeType: String(mediaContext.mimeType || mediaContext.mediaType || ""),
            sourceMessageId: messageId,
          });

          if (delivery.success) {
            // From now on this order has a receipt. The kanban webhook reads this
            // marker to tell the operator's "Запросить снова" press apart from the
            // very first payment request - hub sends one event name for both.
            await markReceiptSeen(ctx.instanceId, String(deliverOrderNumber || "")).catch(() => false);
          }

          if (!delivery.success) {
            await releaseReceiptFingerprint(ctx.instanceId, fingerprint);
            const retryReply =
              ctx.language === "ru"
                ? "Не удалось передать чек оператору. Пожалуйста, отправьте его ещё раз чуть позже."
                : "Чекті операторға жібере алмадым. Сәлден кейін қайта жіберіңіз.";
            await sendCustomerReplyAndFinish(ctx, messageId, retryReply, "payment_receipt_crm_failed");
            return;
          }

          let receiptReply: string;
          if (isShortfall) {
            const expected = Number(receiptContext.expectedAmount || 0);
            const paid = Number(mediaAnalysis.amount || 0);
            const remaining = Math.max(0, expected - paid);
            const requisites = await getPaymentRequisitesText(ctx.instanceId, ctx.config, ctx.language).catch(() => "");
            // The promise below ("оператор уже уведомлён") was not kept: this lane only
            // delivered the receipt and replied. It never opened an operator case, so
            // there was no red panel row and no hub signal, and deliverReceiptToClient's
            // operator comment carries sender/amount/bank only - it never says the amount
            // was SHORT, so the operator saw a receipt that looked like any other
            // payment. Underpaid money is exactly the class the escalation contract calls
            // worse than a double (found 2026-08-23). The case is opened first, and the
            // sentence about the operator is only said when it actually exists.
            const shortfallRouting = await routeComplaintToAdmin(ctx, {
              summary: `Төлем толық емес: тапсырыс ${expected} ₸, чекте ${paid} ₸, жетпейді ${remaining} ₸. Тапсырыс №${deliverOrderNumber}. Чек операторға жіберілді, клиент қалған сомаға жаңа чек жіберуі керек.`,
              customerText: text,
              customerReply: "",
              urgency: "high",
              // Its own source, so the menu-question skip and the AI-tool
              // clarify-first gate cannot swallow a payment shortfall.
              source: "payment_shortfall",
            });
            const operatorLine = shortfallRouting.escalationAvailable
              ? ctx.language === "ru"
                ? " Оператор уже уведомлён и тоже проверит оплату."
                : " Операторға да хабарлама кетті, ол да тексереді."
              : "";
            receiptReply =
              ctx.language === "ru"
                ? `⚠️ *Оплата неполная.*\nСумма заказа: *${expected} ₸*, в вашем чеке: *${paid} ₸*.\nОсталось доплатить: *${remaining} ₸*.\n\nОплата:\n${requisites}\n\nОтправьте новый чек в этот чат.${operatorLine}`
                : `⚠️ *Төлем толық емес.*\nТапсырыс сомасы: *${expected} ₸*, чегіңізде: *${paid} ₸*.\nТағы *${remaining} ₸* жіберуіңіз керек.\n\nТөлем жасау:\n${requisites}\n\nЖаңа чекті осы чатқа жіберіңіз.${operatorLine}`;
          } else {
            receiptReply =
              ctx.language === "ru"
                ? "🧾 Большое спасибо за оплату! Чек отправлен оператору на проверку. Пожалуйста, немного подождите ⏳"
                : "🧾 Төлеміңіз үшін көп рақмет! Чек операторға тексеруге жіберілді. Кішкене күте тұрыңыз ⏳";
          }
          await sendCustomerReplyAndFinish(ctx, messageId, receiptReply, isShortfall ? "payment_receipt_shortfall" : "payment_receipt");
          return;
        }
        if (mediaAnalysis.type === "technical_error") {
          mediaDeveloperError = mediaAnalysis.analysis || "media_analysis_failed";
          // A provider 4xx on what the guest sent ("Unable to process input image" on a
          // sticker or corrupt file) is user input we cannot read, not a system fault. The
          // guest still gets the graceful retry line; what they do NOT get is a developer
          // page - live round A52 paged the owner's phone for a webp sticker. Real outages
          // (5xx, timeouts, exhausted keys) keep the alert.
          const failureText = `${(mediaAnalysis as any).reply_to_customer || ""} ${mediaAnalysis.analysis || ""}`;
          mediaDeveloperErrorIsUserInput =
            /MEDIA_40[0134]|Unable to process input image|unsupported|invalid_image|corrupt/i.test(failureText) &&
            !/50[03]|TIMEOUT|EXHAUSTED|quota/i.test(failureText);
          // SECOND LANE FOR MONEY. An image or PDF we could not read may well be a
          // payment receipt, and "try again later" is the one answer that loses money:
          // the guest has already paid, the file is in our hands, and nobody is told
          // (owner, 2026-08-28: "клиент ақша жіберіп, оны сайтқа жібермесе, проблеманың
          // көкесі болады"). When the reader is down the evidence goes to a human
          // instead - the operator opens the file and checks the payment by hand. Audio
          // is excluded: a voice note is never a receipt.
          mediaUnreadableEvidence = Boolean(
            mediaContext.base64
            && mediaContext.kind !== "audio"
            && mediaContext.kind !== "sticker"
          );
          mediaPreemptiveReply =
            (mediaAnalysis as any).reply_to_customer ||
            stripEscalationSignals(mediaAnalysis.analysis) ||
            (ctx.language === "ru"
              ? "Не получилось обработать файл. Попробуйте отправить его еще раз чуть позже."
              : "Файлды өңдей алмадым. Сәлден соң қайта жіберіп көріңіз.");
          mediaPreemptiveSource = "media_technical_error";
        }
        if (mediaAnalysis.type === "reply") {
          const transcript = voiceTranscriptForAgent(
            mediaAnalysis,
            mediaContext.mimeType || mediaContext.mediaType || ""
          );
          if (transcript) {
            text = transcript;
            customerLanguageText = transcript;
            ctx.text = transcript;
            const voiceLanguage = await detectLanguageDecision(transcript).catch(() => null);
            if (voiceLanguage?.lockable) ctx.language = voiceLanguage.language;
            await refreshCheckoutContextForText(ctx, transcript);
            await saveToHistory(ctx.instanceId, ctx.phone, "user", transcript, {
              source: "voice_transcript",
              messageId,
            });
          } else {
            mediaPreemptiveReply = stripEscalationSignals(mediaAnalysis.analysis);
            mediaPreemptiveSource = mediaContext.kind === "audio" ? "voice_reply" : "media_reply";
          }
        }
        if (mediaAnalysis.type === "complaint" && mediaContext.base64) {
          await saveComplaintMedia(ctx.instanceId, ctx.phone, mediaContext.base64, mediaContext.mimeType || mediaContext.mediaType || "image/jpeg");
          // The reader SAW the defect, so asking the guest to describe it is absurd - and
          // that is exactly what happened to a photo of a nail in the food, twice, once
          // per photo (owner report, 2026-08-29). Visible evidence goes straight to the
          // operator with the summary the reader already wrote; at most ONE specific
          // question rides along ("which dish?"), never "describe the problem".
          const evidenceVisible = Boolean((mediaAnalysis as any).evidence_visible);
          if (!evidenceVisible && !hasMeaningfulMediaDescription(text, mediaContext)) {
            // One question per episode. A guest sending three photos of the same problem
            // used to be asked three times, because nothing remembered that the question
            // was already out.
            const alreadyAsked = await hasComplaintClarificationPending(ctx.instanceId, ctx.phone).catch(() => false);
            if (alreadyAsked) {
              mediaPreemptiveReply = "";
              mediaPreemptiveSource = "complaint_media_awaiting_text";
            } else {
              await markComplaintClarificationPending(ctx.instanceId, ctx.phone, text || "[photo]").catch(() => false);
              mediaPreemptiveReply = buildComplaintClarificationReply(ctx.language);
              mediaPreemptiveSource = "complaint_media_needs_text";
            }
          } else {
            immediateComplaintSummary = mediaAnalysis.admin_summary || mediaAnalysis.analysis || text;
            immediateComplaintMedia = {
              base64: mediaContext.base64,
              mimeType: mediaContext.mimeType || mediaContext.mediaType || "image/jpeg",
            };
            immediateComplaintUrgency = "high";
            mediaPreemptiveReply =
              (mediaAnalysis as any).reply_to_customer ||
              stripEscalationSignals(mediaAnalysis.analysis) ||
              (evidenceVisible
                ? buildEvidenceSeenReply(ctx.language, String((mediaAnalysis as any).evidence_detail || ""))
                : buildComplaintAckReply(ctx.language));
            mediaPreemptiveSource = evidenceVisible ? "media_complaint_evidence_seen" : "media_complaint";
          }
        }
      }
    }

    await syncKanbanEvent(ctx, {
      event: "openbot_inbound",
      message_id: messageId || undefined,
      text,
      media: safeMediaMetadata(mediaContext),
    });

    if (mediaContext) {
      await saveMediaContext(ctx.instanceId, ctx.phone, mediaContext);
    }

    await recordInboundTurn();

    if (mediaDeveloperError && !mediaDeveloperErrorIsUserInput) {
      await notifyDeveloperSystemFailure(ctx.instanceId, new Error(mediaDeveloperError), {
        scope: "media_analysis",
        messageId,
        customerPhone: maskPhone(ctx.phone),
      }).catch(() => undefined);

      // The second lane. A file we could not read may be money already sent, so it is
      // handed to a human with the image attached instead of dying as "try again
      // later" (owner, 2026-08-28). The operator case is what makes a human look:
      // routeComplaintToAdmin opens it, flags the panel row and signals the site, and
      // it carries its own source so neither the menu-question skip nor the
      // clarify-first gate can swallow it.
      if (mediaUnreadableEvidence && mediaContext) {
        const evidenceBase64 = String(mediaContext.base64 || "");
        const evidenceRouting = await routeComplaintToAdmin(ctx, {
          summary: `Клиент файл жіберді, бірақ ИИ оны оқи алмады (медиа талдау істен шықты). Файл осы кейске тіркелді - операторға қолмен тексеру керек. Егер бұл төлем чегі болса, төлемді растап, тапсырысты алға жылжытыңыз. Клиент мәтіні: ${String(text || "").replace(/\s+/g, " ").trim().slice(0, 300)}`,
          customerText: text,
          customerReply: "",
          urgency: "high",
          media: evidenceBase64
            ? {
                base64: evidenceBase64,
                mimeType: String(mediaContext.mimeType || mediaContext.mediaType || "image/jpeg"),
                filename: "unreadable-media",
              }
            : null,
          source: "media_unreadable_evidence",
        }).catch(() => null);

        // Only promise the human when one was actually told. The reply otherwise stays
        // the plain retry line, which is honest about what happened.
        const handedOver = Boolean(evidenceRouting && evidenceRouting.action === "operator_case_created");
        const evidenceReply = handedOver
          ? ctx.language === "ru"
            ? "Файл получил, но автоматически прочитать его не удалось. Передал оператору — он посмотрит вручную. Если это чек об оплате, платёж учтём, ничего отправлять заново не нужно."
            : "Файлды алдым, бірақ автоматты оқи алмадым. Операторға бердім — ол қолмен қарайды. Егер бұл төлем чегі болса, төлем есепке алынады, қайта жіберудің қажеті жоқ."
          : mediaPreemptiveReply;
        await sendCustomerReplyAndFinish(ctx, messageId, evidenceReply, handedOver ? "media_unreadable_escalated" : mediaPreemptiveSource);
        return;
      }

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
        source: "media_analysis",
      });
      await saveToHistory(
        ctx.instanceId,
        ctx.phone,
        "system",
        // The record must say what HAPPENED, not what was attempted. This line was
        // unconditional, so a turn where createOperatorCase could not write (Redis down,
        // hub refusing) still left "operator case created" in the history with caseId:null
        // beside it - support read the complaint back as handled while no operator had
        // ever been told (found 2026-08-23). Same class as the escalation_failed action
        // fix; that one cost 48 hours of invisible SOS failures.
        routing.escalationAvailable ? "operator case created" : `operator case FAILED (${routing.action})`,
        {
          source: "operator-case",
          caseId: routing.caseId,
          mediaAttached: routing.mediaAttached,
          escalationAvailable: routing.escalationAvailable,
          routingAction: routing.action,
        }
      );
      void bumpMetric(ctx.instanceId, "escalations");
      void bumpMetric(ctx.instanceId, "complaints");
      void recordLearningEvent(ctx.instanceId, {
        type: "escalation",
        detail: detectOperatorCaseKind(ctx.text) || "complaint_text",
        phone: maskPhone(ctx.phone),
      });
      if (!routing.escalationAvailable) {
        await notifyDeveloperSystemFailure(ctx.instanceId, new Error("ADMIN_PHONE_NOT_CONFIGURED_FOR_COMPLAINT"), {
          scope: "complaint-routing",
          messageId,
          customerPhone: maskPhone(ctx.phone),
        }).catch(() => undefined);
      }
      await sendCustomerReplyAndFinish(ctx, messageId, routing.customerReply, mediaPreemptiveSource || "media_complaint");
      return;
    }

    if (mediaPreemptiveReply) {
      await sendCustomerReplyAndFinish(ctx, messageId, mediaPreemptiveReply, mediaPreemptiveSource || "media_preemptive_reply");
      return;
    }

    const operationalReply = operationalPreemptionReply(ctx);
    if (operationalReply) {
      await sendCustomerReplyAndFinish(ctx, messageId, operationalReply, "operational_preemption");
      return;
    }

    // A cancellation is settled here, before the status route, but only after the
    // order itself is looked up: there is nothing to cancel until an order
    // exists, and a human is pulled in only when one does (or when the guest
    // asks again). The guest is never told "send the order number" for something
    // the bot could not do with the number anyway.
    if (isOrderCancellationRequest(ctx.text)) {
      const target = await resolveCancellationTarget(ctx);
      const insists = repeatedCancellationRequest(ctx.chatHistory) || isLikelyOperatorRequestText(ctx.text);
      if (target.state === "missing" && !insists) {
        await sendCustomerReplyAndFinish(ctx, messageId, nothingToCancelReply(ctx), "cancel_request:no_order");
        return;
      }
      const cancelReply = target.state === "found"
        ? [target.statusLine, cancellationHandoffReply(ctx, target.orderNumber)].filter(Boolean).join(" ")
        : cancellationHandoffReply(ctx, target.orderNumber);
      const routing = await routeComplaintToAdmin(ctx, {
        summary: stripEscalationSignals(ctx.text),
        customerText: ctx.text,
        customerReply: cancelReply,
        urgency: "high",
        source: "cancel_request",
      });
      await saveToHistory(
        ctx.instanceId,
        ctx.phone,
        "system",
        // The record must say what HAPPENED, not what was attempted. This line was
        // unconditional, so a turn where createOperatorCase could not write (Redis down,
        // hub refusing) still left "operator case created" in the history with caseId:null
        // beside it - support read the complaint back as handled while no operator had
        // ever been told (found 2026-08-23). Same class as the escalation_failed action
        // fix; that one cost 48 hours of invisible SOS failures.
        routing.escalationAvailable ? "operator case created" : `operator case FAILED (${routing.action})`,
        {
          source: "operator-case",
          caseId: routing.caseId,
          mediaAttached: routing.mediaAttached,
          escalationAvailable: routing.escalationAvailable,
          routingAction: routing.action,
        }
      );
      void bumpMetric(ctx.instanceId, "escalations");
      void recordLearningEvent(ctx.instanceId, {
        type: "escalation",
        detail: "cancel_request",
        phone: maskPhone(ctx.phone),
      });
      if (!routing.escalationAvailable) {
        await notifyDeveloperSystemFailure(ctx.instanceId, new Error("ADMIN_PHONE_NOT_CONFIGURED_FOR_COMPLAINT"), {
          scope: "cancel-request",
          messageId,
          customerPhone: maskPhone(ctx.phone),
        }).catch(() => undefined);
      }
      await sendCustomerReplyAndFinish(ctx, messageId, routing.customerReply || cancelReply, "cancel_request");
      return;
    }

    const orderReply = await customerOrderReply(ctx);
    if (orderReply) {
      await sendCustomerReplyAndFinish(ctx, messageId, orderReply, "customer_order_status");
      return;
    }

    const kitchenReply = await kitchenGateReply(ctx);
    if (kitchenReply) { await sendCustomerReplyAndFinish(ctx, messageId, kitchenReply, "kitchen_policy"); return; }

    const prepReply = prepTimeReply(ctx);
    if (prepReply) { await sendCustomerReplyAndFinish(ctx, messageId, prepReply, "kitchen_prep_time"); return; }

    // Pre-LLM short-circuit: if runtime is unavailable and customer asks about kitchen
    const runtimeReply = runtimeUnavailableReply(ctx);
    if (runtimeReply) {
      console.log(`[OPENBOT:PREEMPT] runtime unavailable, using fallback`);
      await sendCustomerReplyAndFinish(ctx, messageId, runtimeReply, "runtime_unavailable");
      return;
    }

    // Deterministic proactive observations (order status changed since the
    // last contact, an abandoned checkout link). Advisory context only: they
    // reach the reply only when relevant to what the guest just said.
    ctx.proactiveSignals = await computeProactiveSignals(ctx).catch(() => null);
    void bumpMetric(ctx.instanceId, "turns");

    const textModels = getTextModels();
    console.log(`[OPENBOT:AI] generating provider=openrouter primary=${textModels.primary} fallback=${textModels.fallback}`);
    const result = await runFastFoodAgent(ctx);
    console.log(
      `[OPENBOT:AI] completed chars=${result.text.length} finish=${result.finishReason || "-"} link=${result.hasLink}` +
      ` planned_tools=${result.toolPlan.requiredTools.join(",") || "auto"}` +
      ` called_tools=${result.toolCalls.map((call: { name: string }) => call.name).join(",") || "none"}` +
      ` validator=${result.validationWarnings.join(",") || "clean"}`
    );

    if (result.thinking) void bumpMetric(ctx.instanceId, "think_used");
    if (result.critic && !result.critic.ok) {
      void bumpMetric(ctx.instanceId, "critic_regens");
      void recordLearningEvent(ctx.instanceId, {
        type: "critic_regen",
        detail: result.critic.issues.slice(0, 4).join(","),
        phone: maskPhone(ctx.phone),
      });
    }
    if (result.validationWarnings.length) {
      void bumpMetric(ctx.instanceId, "validator_edits");
      void recordLearningEvent(ctx.instanceId, {
        type: "validator_edit",
        detail: result.validationWarnings.slice(0, 5).join(","),
        phone: maskPhone(ctx.phone),
      });
      if (result.validationWarnings.some((warning: string) => ["empty_model_output", "foreign_script_output"].includes(warning))) {
        void bumpMetric(ctx.instanceId, "fallbacks");
        void recordLearningEvent(ctx.instanceId, {
          type: "fallback_reply",
          detail: result.validationWarnings.slice(0, 5).join(","),
          phone: maskPhone(ctx.phone),
        });
      }
    }

    const rawAiText = String(result.rawText || result.text || "");
    // A menu/availability/price question can never enter the escalation lane
    // at all - not via the complaint matchers, not via a bare human ask, and
    // not via a misjudged AI signal. It is answered from the menu, period.
    const menuQuestion = isLikelyMenuQuestion(ctx.text);
    // The validator flags a past-tense "the admin has been told" that no escalation tool
    // grounded. Making the guest's promise TRUE is better than rewording it: fold the flag
    // into needsAdminEscalation so the routing below actually creates the case.
    const ungroundedEscalationPromise =
      Array.isArray(result.validationWarnings) &&
      result.validationWarnings.includes("escalation_promise_ungrounded");
    const needsAdminEscalation =
      !menuQuestion &&
      (hasEscalateAdminSignal(rawAiText) ||
        hasEscalateAdminSignal(result.text) ||
        ungroundedEscalationPromise);
    const pendingComplaintMedia = await hasPendingComplaintMedia(ctx.instanceId, ctx.phone);
    // When the escalateToAdmin tool already ran this turn, the routing choke
    // point has decided this escalation (case created, or the guest was asked
    // the one clarifying question and the flag is already marked). Letting the
    // text lane run on top re-marked the flag and re-signaled the site for the
    // same episode, so one SOS surfaced as several site notifications
    // (2026-08-21 badge noise).
    const toolHandledEscalation = Array.isArray(result.toolCalls)
      && result.toolCalls.some((call: any) => call?.name === "escalateToAdmin");
    // Asking for a human, a courier number, or lodging a complaint no longer
    // fires SOS on the spot: a bare demand earns one clarifying question, and
    // only the guest's answer (or a message that already carries the story, or
    // photo evidence) creates the operator case.
    const caseKind = detectOperatorCaseKind(ctx.text);
    const askedForOperator = !menuQuestion && (caseKind === "human_request" || caseKind === "courier_request");
    const complaintText = !menuQuestion && isLikelyComplaintText(ctx.text);
    const awaitingDetailRaw = toolHandledEscalation ? null : await takeComplaintClarification(ctx.instanceId, ctx.phone);
    // "error" means we could not read the state at all. Neither branch may act on a guess:
    // re-asking would double the question, routing would double the case - so this turn
    // stays neutral and lets the agent's own reply stand.
    const clarificationUnknown = awaitingDetailRaw === "error";
    const awaitingDetail = clarificationUnknown ? null : (awaitingDetailRaw as string | null);
    const hasDetailNow = !menuQuestion && complaintHasActionableDetail(ctx.text);
    const needsClarification =
      !toolHandledEscalation
      && !clarificationUnknown
      && (askedForOperator || complaintText || needsAdminEscalation)
      && awaitingDetail === null
      && !pendingComplaintMedia
      && !hasDetailNow;

    const shouldRouteComplaint =
      !toolHandledEscalation
      && !needsClarification
      && !clarificationUnknown
      // The pending flag is the guest's answer to OUR question. A menu question is them
      // moving on to something else, not the detail of a complaint - and without this
      // guard the menu question opened a silent operator case while the reply talked
      // about pizza (found 2026-08-23).
      && !menuQuestion
      && (needsAdminEscalation || pendingComplaintMedia || askedForOperator || complaintText || awaitingDetail !== null);

    if (needsClarification) {
      await markComplaintClarificationPending(ctx.instanceId, ctx.phone, ctx.text).catch(() => false);
    }

    const finalText =
      stripEscalationSignals(result.text)
      || (needsClarification
        ? buildEscalationClarifyQuestion(caseKind, ctx.language)
        : shouldRouteComplaint ? buildComplaintAckReply(ctx.language) : result.text);

    if (shouldRouteComplaint) {
      const routing = await routeComplaintToAdmin(ctx, {
        // The summary is what the operator reads on the SOS card, so it has to be
        // the guest's own words. It used to prefer rawAiText, which meant a refund
        // demand showed up in the panel as our own apology back to them and the
        // operator had to open the chat to learn what happened (live round,
        // 2026-08-12). The first message named the problem and this one adds the
        // detail, so both halves are kept, guest text first. The AI line is only
        // a fallback for a turn with no customer text at all, such as media.
        summary: [awaitingDetail, stripEscalationSignals(ctx.text) || stripEscalationSignals(rawAiText || finalText)]
          .filter(Boolean)
          .join(" — "),
        customerText: [awaitingDetail, ctx.text].filter(Boolean).join(" — "),
        customerReply: finalText,
        urgency: needsAdminEscalation ? "high" : "normal",
        source: needsAdminEscalation ? "ai_escalation_signal" : pendingComplaintMedia ? "pending_complaint_media" : detectOperatorCaseKind(ctx.text) || "complaint_text",
      });
      await saveToHistory(
        ctx.instanceId,
        ctx.phone,
        "system",
        // The record must say what HAPPENED, not what was attempted. This line was
        // unconditional, so a turn where createOperatorCase could not write (Redis down,
        // hub refusing) still left "operator case created" in the history with caseId:null
        // beside it - support read the complaint back as handled while no operator had
        // ever been told (found 2026-08-23). Same class as the escalation_failed action
        // fix; that one cost 48 hours of invisible SOS failures.
        routing.escalationAvailable ? "operator case created" : `operator case FAILED (${routing.action})`,
        {
          source: "operator-case",
          caseId: routing.caseId,
          mediaAttached: routing.mediaAttached,
          escalationAvailable: routing.escalationAvailable,
          routingAction: routing.action,
        }
      );
      if (!routing.escalationAvailable) {
        await notifyDeveloperSystemFailure(ctx.instanceId, new Error("ADMIN_PHONE_NOT_CONFIGURED_FOR_COMPLAINT"), {
          scope: "complaint-routing",
          messageId,
          customerPhone: maskPhone(ctx.phone),
        }).catch(() => undefined);
      }
    }

    void evaluateForShpor(ctx.text, finalText)
      .then((evaluation) => {
        if (evaluation.save) {
          return saveToShpor(ctx.instanceId, ctx.text, finalText, evaluation.category || "faq", evaluation.memory || null);
        }
        return undefined;
      })
      .catch((error) => {
        console.warn("[SHPOR:EVAL] async save skipped:", error?.message || error);
        void notifyDeveloperSystemFailure(ctx.instanceId, error, {
          scope: "shpor_async_save",
          messageId,
          customerPhone: maskPhone(ctx.phone),
        }).catch(() => undefined);
      });

    // Outbound duplicate guard: an identical reply for THIS SAME turn
    // (parallel batch, retried webhook) is dropped instead of shown twice.
    // The turn key is what keeps a repeated guest question answerable: the
    // guard used to silence any identical reply within 60s, so a guest who
    // asked the same thing twice got no answer at all the second time.
    const outboundIsNew = await claimOutboundReply(ctx.instanceId, ctx.phone, finalText, messageId).catch(() => true);
    if (!outboundIsNew) {
      console.warn(`[OPENBOT:OUTBOUND] duplicate reply suppressed instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)}`);
      await markInboundDone(ctx.instanceId, messageId);
      return;
    }

    // Send main text response
    const sendResult = await sendWhatsProResponseSequence({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      text: finalText,
      requestScope: messageId,
      pace: resolvePaceUrgency(ctx),
    });

    if (!sendResult.ok) throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", finalText, { source: "openbot-agent", ...noteHistoryMeta(ctx, finalText) });

    // The personal ordering link always travels as its own message, never glued
    // to the reply text (product rule, 2026-08-14): it stays easy to find in the
    // chat, and the answer reads like a human wrote it.
    if (ctx.magicLinkGranted && ctx.magicLink) {
      const linkSend = await sendWhatsProResponseSequence({
        instanceId: ctx.instanceId,
        phone: ctx.phone,
        text: ctx.magicLink,
        requestScope: `${messageId}:magic-link`,
      }).catch(() => null);
      if (linkSend?.ok) {
        await saveToHistory(ctx.instanceId, ctx.phone, "assistant", ctx.magicLink, { source: "openbot-agent" });
      } else {
        console.warn(`[OPENBOT:OUTBOUND] magic link send failed instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)}`);
      }
    }
    await markInboundDone(ctx.instanceId, messageId);
    await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch(() => false);

    // Sweep leftovers from the burst we just answered so they cannot become a second
    // reply. What arrived DURING this turn is a different matter: requeueInboundText put
    // it here precisely so it would not be lost, and this sweep used to delete it
    // unanswered - the guest's message vanished with no reply at all (found 2026-08-23).
    // Anything still buffered after the answer went out is therefore re-armed as its own
    // pending batch instead of being dropped.
    void drainInboundBuffer(ctx.instanceId, ctx.phone)
      .then(async (leftovers) => {
        const pending = (leftovers || []).filter(Boolean);
        if (!pending.length) return;
        console.warn(
          `[OPENBOT:BUFFER] ${pending.length} part(s) arrived mid-turn, re-arming instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)}`
        );
        for (const part of pending) {
          await requeueInboundText({ instanceId: ctx.instanceId, phone: ctx.phone, messageId: "", text: part }).catch(() => undefined);
        }
      })
      .catch(() => undefined);

    // The customer's mission advances only after their reply is safely out.
    // Fire-and-forget: one tiny Redis value, never on the latency path.
    void updateGoalAfterTurn({
      ctx,
      analysis: result.thinking || null,
      escalated:
        shouldRouteComplaint ||
        result.toolCalls.some((call: { name: string }) => call.name === "escalateToAdmin"),
    }).catch(() => undefined);
    void recordLatency(ctx.instanceId, Date.now() - started);
    if (result.hasLink) void bumpMetric(ctx.instanceId, "links_sent");

    // Memory is written only after the customer already has the reply, so it can
    // never add latency to the answer and can never fail the request. The trace
    // is what makes the agent self-aware on the next turn; the profile/summary
    // refresh is what makes it remember this customer at all.
    void recordTurnTrace({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      trace: {
        tools: result.toolCalls.map((call: { name: string }) => call.name),
        planned_tools: result.toolPlan.requiredTools,
        warnings: result.validationWarnings,
        validator_edited: result.validationWarnings.length > 0,
        media_analysed: Boolean(ctx.mediaContext),
        reply_had_link: Boolean(result.hasLink),
        think_goal: result.thinking?.goal || null,
        think_mood: result.thinking?.mood || null,
        think_risk: result.thinking?.risk || null,
        critic_issues: Array.isArray(result.critic?.issues) ? result.critic.issues.slice(0, 4) : [],
      },
    }).catch(() => undefined);
    void refreshCustomerMemory({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      history: [
        ...(Array.isArray(ctx.chatHistory) ? ctx.chatHistory : []),
        { role: "user", text: ctx.text },
        { role: "assistant", text: finalText },
      ],
      language: ctx.language,
    }).catch(() => undefined);
    console.log(
      `[OPENBOT:OUTBOUND] sent instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} chunks=${sendResult.chunks || 0} ok=${Boolean(sendResult?.ok)} link_separate=${result.hasLink} elapsed=${Date.now() - started}ms`
    );
  } catch (error) {
    await clearInboundProcessing(String(instanceId || ""), messageId).catch(() => undefined);
    await notifyDeveloperSystemFailure(String(instanceId || ""), error, {
      scope: "whatsapp_webhook",
      messageId,
      customerPhone: maskPhone(phone),
    }).catch(() => undefined);
    throw error;
  } finally {
    stopTyping();
    if (turnLockOwner) {
      void releaseTurnLock(instanceId, phone, turnLockOwner).catch(() => undefined);
      turnLockOwner = null;
    }
  }
}

export function whatsappWebhookRoute(): Router {
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
      const opText = extractInboundText(body) || "[Оператор сөйледі]";
      await setOperatorAutoMute(instanceId, phone).catch((error: any) => {
        console.warn("[OPENBOT:OPERATOR:MUTE:FAIL]", error?.message || error);
        void notifyDeveloperSystemFailure(instanceId, error, {
          scope: "operator_auto_mute",
          customerPhone: maskPhone(phone),
        }).catch(() => undefined);
      });
      if (instanceId && phone && opText) {
        await saveToHistory(instanceId, phone, "operator", opText, { source: "operator_from_me" }).catch((error: any) => {
          console.warn("[OPENBOT:OPERATOR:HISTORY:FAIL]", error?.message || error);
          void notifyDeveloperSystemFailure(instanceId, error, {
            scope: "operator_history",
            customerPhone: maskPhone(phone),
          }).catch(() => undefined);
        });
      }
      console.log(`[OPENBOT:INBOUND:SKIP] fromMe=true elapsed=${Date.now() - started}ms`);
      return res.status(202).json({ ok: true, skipped: true, reason: "fromMe" });
    }

    // An internal incident alarm can echo back into the very chat it was sent to, and
    // then it was replayed as if a guest had written it: the bot apologised to the
    // developer for its own diagnostics (audit, 2026-08-13). Our own alarm text is
    // never a guest turn.
    const inboundText = extractInboundText(body) || "";
    if (DEVELOPER_ALERT_MARKER_RE.test(inboundText)) {
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${getInstanceId(body) || "-"} phone=${maskPhone(getPhone(body))} reason=developer_alert_echo elapsed=${Date.now() - started}ms`
      );
      return res.status(202).json({ ok: true, skipped: true, reason: "developer_alert_echo" });
    }

    const mediaContext = extractInboundMedia(body);
    const text =
      inboundText ||
      mediaContext?.caption ||
      mediaContext?.historyLabel ||
      (mediaContext ? "[Media sent]" : "");
    if (!String(text || "").trim() && !mediaContext) {
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${getInstanceId(body) || "-"} phone=${maskPhone(getPhone(body))} reason=empty_message elapsed=${Date.now() - started}ms`
      );
      return res.status(200).send("ok");
    }

    setImmediate(() => {
      void processWhatsAppWebhook(body, started).catch((error: any) => {
        console.error(`[OPENBOT:INBOUND:FAIL] elapsed=${Date.now() - started}ms:`, error?.stack || error?.message || error);
      });
    });

    return res.status(202).json({ ok: true, accepted: true });
  });

  return router;
}

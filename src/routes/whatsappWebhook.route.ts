import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import {
  claimReceiptFingerprint,
  clearPendingKitchenConsent,
  getPendingKitchenConsent,
  getKitchenCheckoutFingerprint,
  releaseReceiptFingerprint,
  markComplaintClarificationPending,
  saveComplaintMedia,
  savePendingKitchenConsent,
  saveToHistory,
  takeComplaintClarification,
} from "../services/redis.service.js";
import {
  buildComplaintAckReply,
  buildComplaintClarificationReply,
  buildComplaintDetailQuestion,
  complaintHasActionableDetail,
  hasEscalateAdminSignal,
  hasEscalateDeveloperSignal,
  hasPendingComplaintMedia,
  isLikelyComplaintText,
  isLikelyOperatorRequestText,
  routeComplaintToAdmin,
  stripEscalationSignals,
  type ComplaintMediaPayload,
  type ComplaintUrgency,
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
  setOperatorAutoMute,
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
  validateReceiptAnalysis,
} from "../services/mediaAnalysis.service.js";
import { getTextModels } from "../services/llm.service.js";
import { classifyKitchenSalesPolicy, detectKitchenConsentAnswer, detectRequestedServiceChannel, type KitchenSalesPolicy } from "../services/kitchenPolicy.service.js";
import { isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp, requestedOrderNumber } from "../utils/orderIntent.js";
import type { FastFoodContext } from "../context/types.js";
import { noteHistoryMeta } from "../services/noteProvenance.service.js";
import { bumpOperatorCaseSignal, detectOperatorCaseKind } from "../services/operatorCase.service.js";

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
    return "Не удалось подтвердить подлинность чека. Отправьте, пожалуйста, свежий полный чек, где видны имя отправителя, банк, сумма и дата.";
  }
  if (reason === "amount_mismatch") return "Чектегі сома тапсырыс сомасына сәйкес емес. Дұрыс чекті жіберіңіз.";
  if (["receipt_too_old", "receipt_before_order"].includes(reason)) return "Бұл чек ескі немесе тапсырыстан бұрын жасалған. Осы тапсырысқа арналған жаңа чекті жіберіңіз.";
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
function isOwnWhatsAppMessage(body: any): boolean {
  return body?.fromMe === true || body?.isFromMe === true || body?.data?.key?.fromMe === true;
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

async function customerOrderReply(ctx: FastFoodContext): Promise<string | null> {
  if (!isCustomerOrderStatusQuestion(ctx.text) && !(ctx.activeOrder && isLikelyOrderStatusFollowUp(ctx.text))) return null;
  const orderNumber = requestedOrderNumber(ctx.text);
  const lookup = orderNumber
    ? await getCustomerOrder(ctx.instanceId, String(ctx.config?.domain || ""), ctx.phone, ctx.language, orderNumber)
    : ctx.activeOrder?.is_stale
      ? { state: "unavailable" as const }
      : customerOrderFromRecord(ctx.activeOrder, ctx.phone, ctx.language);
  if (lookup.state === "found") return formatCustomerOrderStatus(lookup.order, ctx.language);
  if (lookup.state === "unavailable") return unavailableOrderReply(ctx.language);
  return missingOrderReply(ctx.language);
}

function busyKitchenReply(policy: KitchenSalesPolicy, language: "kk" | "ru") {
  return language === "ru"
    ? `Сейчас много заказов, поэтому приготовление или доставка могут задержаться примерно на ${policy.waitLabelRu}. Вы согласны подождать и продолжить?`
    : `Қазір тапсырыс көп болғандықтан дайындау немесе жеткізу шамамен ${policy.waitLabelKk} кешігуі мүмкін. Күтіп, жалғастыруға келісесіз бе?`;
}
function closedKitchenReply(policy: KitchenSalesPolicy, language: "kk" | "ru") {
  if (language === "ru") {
    if (policy.mode === "vacation") return `Сейчас временно не принимаем заказы${policy.remainingDays ? ` примерно ${policy.remainingDays} дн.` : ""}. Напишите нам немного позже — мы сообщим актуальную информацию. Спасибо за понимание.`;
    if (policy.mode === "indefinite") return "По важной технической причине временно не принимаем заказы. Пожалуйста, напишите нам немного позже, чтобы уточнить актуальную ситуацию. Спасибо за понимание.";
    return "По важной технической причине временно не принимаем заказы. Пожалуйста, попробуйте написать нам немного позже. Спасибо за понимание.";
  }
  if (policy.mode === "vacation") return `Қазір уақытша тапсырыс қабылдамаймыз${policy.remainingDays ? `, шамамен ${policy.remainingDays} күн` : ""}. Біраздан кейін қайта жазып, өзекті жағдайды нақтылап көріңіз. Түсіністік танытқаныңызға рақмет.`;
  if (policy.mode === "indefinite") return "Маңызды техникалық себепке байланысты уақытша тапсырыс қабылдамаймыз. Біраздан кейін қайта жазып, өзекті жағдайды нақтылап көріңіз. Түсіністік танытқаныңызға рақмет.";
  return "Маңызды техникалық себепке байланысты уақытша тапсырыс қабылдамаймыз. Біраздан кейін қайта жазып көріңіз. Түсіністік танытқаныңызға рақмет.";
}
function unavailableChannelReply(channel: "delivery" | "pickup", language: "kk" | "ru") {
  if (language === "ru") return channel === "delivery" ? "Сейчас доставка временно недоступна, но можно оформить самовывоз." : "Сейчас самовывоз временно недоступен, но можно оформить доставку.";
  return channel === "delivery" ? "Қазір жеткізу уақытша қолжетімсіз, бірақ алып кетуге тапсырыс бере аласыз." : "Қазір алып кету уақытша қолжетімсіз, бірақ жеткізуге тапсырыс бере аласыз.";
}
async function kitchenGateReply(ctx: FastFoodContext): Promise<string | null> {
  if (ctx.activeOrder) return null;
  const policy = classifyKitchenSalesPolicy(ctx.runtimeStatus);
  // A guest who already has the link is left to finish, but only while the
  // kitchen is what it was when they got it. A real change reopens the gate.
  const checkoutFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
  if (checkoutFingerprint && checkoutFingerprint === policy.fingerprint) return null;
  const pending = await getPendingKitchenConsent(ctx.instanceId, ctx.phone).catch(() => null);
  if (pending) {
    if (pending.policyFingerprint !== policy.fingerprint) await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
    else {
      const answer = detectKitchenConsentAnswer(ctx.text);
      if (answer === "yes") { await clearPendingKitchenConsent(ctx.instanceId, ctx.phone); return null; }
      if (answer === "no") { await clearPendingKitchenConsent(ctx.instanceId, ctx.phone); return ctx.language === "ru" ? "Хорошо, заказ не продолжаем. Если решите позже — напишите нам." : "Жақсы, тапсырысты жалғастырмаймыз. Кейін шешсеңіз, бізге жазыңыз."; }
      // Neither yes nor no: the guest is still talking. Let the agent answer them
      // and raise the wait itself rather than repeating a confirm-yes-or-no line.
      return null;
    }
  }
  if (policy.blocksAllSales) return closedKitchenReply(policy, ctx.language);
  const channel = detectRequestedServiceChannel(ctx.text);
  if (channel === "delivery" && !policy.delivery) return unavailableChannelReply(channel, ctx.language);
  if (channel === "pickup" && !policy.pickup) return unavailableChannelReply(channel, ctx.language);
  // A busy kitchen is a thing to mention, not a wall to put in front of a guest
  // who only said hello. Record that consent is owed and let the agent greet,
  // answer, and raise the wait in its own words; FACTS_CONTEXT carries
  // wait_consent_required so it knows it has to ask before the order is placed.
  if (policy.requiresConsent) { await savePendingKitchenConsent(ctx.instanceId, ctx.phone, policy.fingerprint); return null; }
  return null;
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
    const delivery = await sendWhatsProResponseSequence({ instanceId: ctx.instanceId, phone: ctx.phone, text: cleanReply });
    if (!delivery.ok) throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", cleanReply, { source, ...noteHistoryMeta(ctx, cleanReply) });
  }
  await markInboundDone(ctx.instanceId, messageId);
  await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch(() => false);
}

async function processWhatsAppWebhook(body: any, started: number) {
  const instanceId = getInstanceId(body);
  const phone = getPhone(body);
  const messageId = extractMessageId(body);
  let mediaContext = extractInboundMedia(body);
  const senderMeta = extractSenderMeta(body);
  let text =
    extractInboundText(body) ||
    mediaContext?.caption ||
    mediaContext?.historyLabel ||
    (mediaContext ? "[Media sent]" : "");
  let customerLanguageText = extractInboundText(body) || mediaContext?.caption || "";
  let stopTyping: () => void = () => {};

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
      senderMeta,
    });
    if (guard.blocked) {
      if (guard.source === "operator_override") {
        await saveToHistory(String(instanceId || ""), String(phone || ""), "user", text || mediaContext?.historyLabel || "[operator override]", {
          source: "operator_override",
          media: safeMediaMetadata(mediaContext),
        });
      }
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=${guard.reason || "blocked"} elapsed=${Date.now() - started}ms`
      );
      return;
    }

    // Stickers are accepted by the gateway, but never sent to AI or persisted.
    if (mediaContext?.kind === "sticker") {
      await markInboundDone(instanceId, messageId);
      return;
    }

    // Merge fragmented text messages in a small, short-lived Redis buffer.
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
      const reply =
        ctx.language === "ru"
          ? "Извините, я не принимаю видео. Пожалуйста, опишите, что произошло, текстом или отправьте фото."
          : "Кешіріңіз, видео қабылдай алмаймын. Не болғанын мәтінмен түсіндіріңіз немесе фото жіберіңіз.";
      await sendWhatsProResponseSequence({ instanceId: ctx.instanceId, phone: ctx.phone, text: reply });
      await markInboundDone(ctx.instanceId, messageId);
      return;
    }

    if (mediaContext && !mediaContext.valid) {
      if (mediaContext.reason === "voice_too_long") {
        const routing = await routeComplaintToAdmin(ctx, {
          summary: `Клиент ұзақ дауыстық хабарлама жіберді (${mediaContext.durationSeconds || "?"} сек). Оператордың жауабы қажет.`,
          customerText: text,
          customerReply: "",
          urgency: "normal",
          source: "long_voice_requires_operator",
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
          if (!(await claimReceiptFingerprint(ctx.instanceId, fingerprint))) {
            const duplicateReply =
              ctx.language === "ru"
                ? "Этот чек уже был отправлен. Пожалуйста, не отправляйте один чек повторно."
                : "Бұл чек бұрын жіберілген. Бір чекті қайта жібермеңіз.";
            await sendCustomerReplyAndFinish(ctx, messageId, duplicateReply, "payment_receipt_duplicate");
            return;
          }

          const receiptOrderNumber = mediaAnalysis.order_id !== "0"
            ? String(mediaAnalysis.order_id)
            : String(activeOrder.id || activeOrder.order_id || "");
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
            paidAt: mediaAnalysis.date_time,
          });

          if (!delivery.success) {
            await releaseReceiptFingerprint(ctx.instanceId, fingerprint);
            const retryReply =
              ctx.language === "ru"
                ? "Не удалось передать чек оператору. Пожалуйста, отправьте его ещё раз чуть позже."
                : "Чекті операторға жібере алмадым. Сәлден кейін қайта жіберіңіз.";
            await sendCustomerReplyAndFinish(ctx, messageId, retryReply, "payment_receipt_crm_failed");
            return;
          }

          const receiptReply =
            ctx.language === "ru"
              ? "🧾 Большое спасибо за оплату! Чек отправлен оператору на проверку. Пожалуйста, немного подождите ⏳"
              : "🧾 Төлеміңіз үшін көп рақмет! Чек операторға тексеруге жіберілді. Кішкене күте тұрыңыз ⏳";
          await sendCustomerReplyAndFinish(ctx, messageId, receiptReply, "payment_receipt");
          return;
        }
        if (mediaAnalysis.type === "technical_error") {
          mediaDeveloperError = mediaAnalysis.analysis || "media_analysis_failed";
          mediaPreemptiveReply =
            (mediaAnalysis as any).reply_to_customer ||
            stripEscalationSignals(mediaAnalysis.analysis) ||
            (ctx.language === "ru"
              ? "Не получилось обработать файл. Попробуйте отправить его еще раз чуть позже."
              : "Файлды өңдей алмадым. Сәлден соң қайта жіберіп көріңіз.");
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
              mimeType: mediaContext.mimeType || mediaContext.mediaType || "image/jpeg",
            };
            immediateComplaintUrgency = "high";
            mediaPreemptiveReply =
              (mediaAnalysis as any).reply_to_customer ||
              stripEscalationSignals(mediaAnalysis.analysis) ||
              buildComplaintAckReply(ctx.language);
            mediaPreemptiveSource = "media_complaint";
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

    await saveToHistory(ctx.instanceId, ctx.phone, "user", ctx.text, {
      source: "openbot-agent",
      media: safeMediaMetadata(mediaContext),
    });

    if (mediaDeveloperError) {
      await notifyDeveloperSystemFailure(ctx.instanceId, new Error(mediaDeveloperError), {
        scope: "media_analysis",
        messageId,
        customerPhone: maskPhone(ctx.phone),
      }).catch(() => undefined);
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
      await saveToHistory(ctx.instanceId, ctx.phone, "system", "operator case created", {
        source: "operator-case", caseId: routing.caseId, mediaAttached: routing.mediaAttached,
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

    const orderReply = await customerOrderReply(ctx);
    if (orderReply) {
      await sendCustomerReplyAndFinish(ctx, messageId, orderReply, "customer_order_status");
      return;
    }

    const kitchenReply = await kitchenGateReply(ctx);
    if (kitchenReply) { await sendCustomerReplyAndFinish(ctx, messageId, kitchenReply, "kitchen_policy"); return; }

    // Pre-LLM short-circuit: if runtime is unavailable and customer asks about kitchen
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
    // Asking for a human is not a complaint to investigate — hand it over at
    // once. A complaint gets one calm question when it names nothing yet, and
    // the pending flag makes the next message escalate whatever it contains.
    const askedForOperator = isLikelyOperatorRequestText(ctx.text);
    const complaintText = isLikelyComplaintText(ctx.text);
    const awaitingDetail = await takeComplaintClarification(ctx.instanceId, ctx.phone);
    const complaintNeedsDetail =
      complaintText && !askedForOperator && !needsAdminEscalation && !pendingComplaintMedia
      && awaitingDetail === null && !complaintHasActionableDetail(ctx.text);

    const shouldRouteComplaint =
      !complaintNeedsDetail
      && (needsAdminEscalation || pendingComplaintMedia || askedForOperator || complaintText || awaitingDetail !== null);

    if (complaintNeedsDetail) {
      await markComplaintClarificationPending(ctx.instanceId, ctx.phone, ctx.text).catch(() => false);
    }

    const finalText =
      stripEscalationSignals(result.text)
      || (complaintNeedsDetail ? buildComplaintDetailQuestion(ctx.language) : shouldRouteComplaint ? buildComplaintAckReply(ctx.language) : result.text);

    if (needsDeveloperEscalation) {
      await notifyDeveloperSystemFailure(ctx.instanceId, new Error("AI requested developer escalation"), {
        scope: "ai-router",
        messageId,
        customerPhone: maskPhone(ctx.phone),
      }).catch(() => undefined);
    }

    if (shouldRouteComplaint) {
      const routing = await routeComplaintToAdmin(ctx, {
        // The first message named the problem, this one adds the detail. The
        // operator needs both, not whichever half arrived last.
        summary: [awaitingDetail, stripEscalationSignals(rawAiText || finalText || ctx.text)].filter(Boolean).join(" — "),
        customerText: [awaitingDetail, ctx.text].filter(Boolean).join(" — "),
        customerReply: finalText,
        urgency: needsAdminEscalation ? "high" : "normal",
        source: needsAdminEscalation ? "ai_escalation_signal" : pendingComplaintMedia ? "pending_complaint_media" : detectOperatorCaseKind(ctx.text) || "complaint_text",
      });
      await saveToHistory(ctx.instanceId, ctx.phone, "system", "operator case created", {
        source: "operator-case", caseId: routing.caseId, mediaAttached: routing.mediaAttached,
      });
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

    // Send main text response
    const sendResult = await sendWhatsProResponseSequence({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      text: finalText,
    });

    if (!sendResult.ok) throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", finalText, { source: "openbot-agent", ...noteHistoryMeta(ctx, finalText) });
    await markInboundDone(ctx.instanceId, messageId);
    await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch(() => false);
    console.log(
      `[OPENBOT:OUTBOUND] sent instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} chunks=${sendResult.chunks || 0} ok=${Boolean(sendResult?.ok)} link_in_text=${result.hasLink} elapsed=${Date.now() - started}ms`
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

    const mediaContext = extractInboundMedia(body);
    const text =
      extractInboundText(body) ||
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

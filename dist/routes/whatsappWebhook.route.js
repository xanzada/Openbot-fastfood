import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import { recordTurnTrace, refreshCustomerMemory } from "../services/customerMemory.service.js";
import { claimReceiptFingerprint, clearPendingKitchenConsent, getPendingKitchenConsent, getKitchenCheckoutFingerprint, markKitchenCheckoutStarted, releaseReceiptFingerprint, markComplaintClarificationPending, saveComplaintMedia, savePendingKitchenConsent, saveToHistory, takeComplaintClarification, } from "../services/redis.service.js";
import { buildComplaintAckReply, buildComplaintClarificationReply, buildComplaintDetailQuestion, complaintHasActionableDetail, hasEscalateAdminSignal, hasPendingComplaintMedia, isLikelyComplaintText, isLikelyOperatorRequestText, routeComplaintToAdmin, stripEscalationSignals, } from "../services/complaintRouting.service.js";
import { acquireTurnLock, bufferInboundText, claimMediaAiQuota, claimOutboundReply, drainInboundBuffer, releaseTurnLock, clearInboundProcessing, extractInboundMedia, extractSenderMeta, extractInboundText, extractMessageId, guardIncomingMessage, hydrateInboundMedia, markInboundDone, safeMediaMetadata, saveMediaContext, setOperatorAutoMute, } from "../services/inboundGuard.service.js";
import { syncKanbanEvent } from "../services/kanbanSync.service.js";
import { notifyAllDevelopersSystemFailure, notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { markWhatsProChatRead, sendWhatsProResponseSequence, startWhatsProTyping } from "../transport/whatspro.client.js";
import { getPhoneCandidatesFromWebhook, normalizePhoneFromCandidates } from "../services/dle.service.js";
import { customerOrderFromRecord, pickConversationOrder, formatCustomerOrderStatus, getCustomerOrder } from "../services/customerOrder.service.js";
import { deliverReceiptToClient } from "../services/receiptDelivery.service.js";
import { evaluateForShpor, getRestaurantConfig, getRestaurantConfigByWhatsAppPhone, isTenantBotEnabled, saveToShpor } from "../services/platformConfig.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import { analyzeMedia, createReceiptFingerprint, receiptFilterEnabled, validateReceiptAnalysis, } from "../services/mediaAnalysis.service.js";
import { getTextModels } from "../services/llm.service.js";
import { classifyKitchenSalesPolicy, formatKitchenWait, detectKitchenConsentAnswer, detectRequestedServiceChannel } from "../services/kitchenPolicy.service.js";
import { isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp, isOrderTimingQuestion, isProspectiveOrderTimingQuestion, lastDiscussedOrderNumber, requestedOrderNumber } from "../utils/orderIntent.js";
import { noteHistoryMeta } from "../services/noteProvenance.service.js";
import { buildBlockedMenuItemReply, buildUnverifiedPaymentClaimReply, findBlockedMenuItemMention, isUnverifiedPaymentClaim, } from "../services/operationalPreemption.service.js";
import { bumpOperatorCaseSignal, detectOperatorCaseKind } from "../services/operatorCase.service.js";
import { computeProactiveSignals } from "../services/proactiveSignals.service.js";
import { updateGoalAfterTurn } from "../services/goalTracker.service.js";
import { recordLearningEvent } from "../services/learningLoop.service.js";
import { bumpMetric, recordLatency } from "../services/metrics.service.js";
import { mergeBufferedParts } from "../services/bufferBrain.service.js";
const STATUS_CONTEXT_RE = /(асүй|ас үй|кухн|kitchen|повар|cook|статус|status|ашылды ма|жабық па|жұмыс істеп жатыр|работает|открыт|закрыт|готов|дайын)/iu;
function maskPhone(phone = "") {
    const clean = String(phone || "").replace(/\D/g, "");
    if (clean.length <= 6)
        return clean || "-";
    return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}
function rejectedReceiptReply(language, reason) {
    if (language === "ru") {
        if (reason === "amount_mismatch")
            return "Сумма в чеке не совпадает с суммой заказа. Отправьте, пожалуйста, правильный чек.";
        if (["receipt_too_old", "receipt_before_order"].includes(reason))
            return "Этот чек старый или был создан до заказа. Отправьте новый чек по текущему заказу.";
        return "Не удалось подтвердить подлинность чека. Отправьте, пожалуйста, свежий полный чек, где видны имя отправителя, банк, сумма и дата.";
    }
    if (reason === "amount_mismatch")
        return "Чектегі сома тапсырыс сомасына сәйкес емес. Дұрыс чекті жіберіңіз.";
    if (["receipt_too_old", "receipt_before_order"].includes(reason))
        return "Бұл чек ескі немесе тапсырыстан бұрын жасалған. Осы тапсырысқа арналған жаңа чекті жіберіңіз.";
    return "Чектің дұрыстығын растай алмадым. Жіберушінің аты, банк, сома және күні анық көрінетін толық жаңа чекті жіберіңіз.";
}
function getInstanceId(body) {
    return String(body?.instance ||
        body?.instanceId ||
        body?.instance_id ||
        body?.restaurant_id ||
        body?.restaurant_instance ||
        body?.restaurantInstance ||
        body?.data?.instance ||
        body?.data?.instanceId ||
        body?.data?.instance_id ||
        body?.data?.restaurant_id ||
        "").trim();
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
        if (phone)
            return phone;
    }
    return "";
}
function getReceiverPhone(body) {
    const eventData = body?.data || body || {};
    const instance = body?.instanceData || body?.instance_data || eventData?.instanceData || eventData?.instance_data || {};
    const me = body?.me || eventData?.me || body?.account || eventData?.account || {};
    return firstPhoneCandidate(body?.receiver_phone, body?.receiverPhone, body?.recipient_phone, body?.recipientPhone, body?.to_phone, body?.toPhone, body?.bot_phone, body?.botPhone, body?.instance_phone, body?.instancePhone, body?.whatsapp_phone, body?.whatsappPhone, body?.whatspro_phone, body?.whatsproPhone, body?.receiver, body?.to, body?.recipient, eventData?.receiver_phone, eventData?.receiverPhone, eventData?.recipient_phone, eventData?.recipientPhone, eventData?.to_phone, eventData?.toPhone, eventData?.bot_phone, eventData?.botPhone, eventData?.instance_phone, eventData?.instancePhone, eventData?.whatsapp_phone, eventData?.whatsappPhone, eventData?.whatspro_phone, eventData?.whatsproPhone, eventData?.receiver, eventData?.to, eventData?.recipient, instance?.phone, instance?.number, instance?.jid, me?.phone, me?.number, me?.id, me?.jid);
}
async function resolveTenantInstance(req, _res, next) {
    const body = req.body || {};
    if (getInstanceId(body))
        return next();
    try {
        const receiverPhone = getReceiverPhone(body);
        if (!receiverPhone)
            return next();
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
    }
    catch (error) {
        console.warn("[OPENBOT:TENANT:RESOLVE:FAIL]", error?.message || error);
        void notifyAllDevelopersSystemFailure(error, {
            scope: "tenant_resolution",
            customerPhone: maskPhone(getReceiverPhone(body)),
        }).catch(() => undefined);
        return next();
    }
}
async function verifySecret(req, res, next) {
    const expected = process.env.OPENBOT_WEBHOOK_SECRET;
    const got = req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
        req.headers["x-api-key"] ||
        req.body?.token ||
        req.query?.token;
    if (expected && safeCompare(got, expected))
        return next();
    try {
        const instanceId = getInstanceId(req.body || {});
        if (!instanceId)
            return res.status(401).json({ ok: false, error: "unauthorized" });
        const config = await getRestaurantConfig(instanceId);
        assertTenantSecret(req, config, "webhook");
        return next();
    }
    catch (error) {
        return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
    }
}
function isOwnWhatsAppMessage(body) {
    return body?.fromMe === true || body?.isFromMe === true || body?.data?.key?.fromMe === true;
}
function isGroupMessage(body) {
    const eventData = body?.data || body || {};
    const key = eventData?.key || body?.key || {};
    return Boolean(body?.isGroup === true ||
        eventData?.isGroup === true ||
        key?.remoteJid?.endsWith?.("@g.us") ||
        key?.participant?.endsWith?.("@g.us") ||
        String(body?.sender || eventData?.sender || body?.from || eventData?.from || "").endsWith("@g.us"));
}
function isIncomingVoiceCall(body) {
    // WhatsPro / Evolution-API delivers calls two ways:
    //   1. A dedicated "call" event  → body.event === "call"
    //   2. A messages.upsert where the message type is "callLogMessage"
    const event = String(body?.event || "").toLowerCase();
    if (event === "call")
        return true;
    const msg = body?.data?.message || body?.message || {};
    const inner = msg?.ephemeralMessage?.message || msg || {};
    if (inner?.callLogMessage)
        return true;
    const messageType = String(body?.data?.messageType || body?.messageType || body?.data?.type || body?.type || "").toLowerCase();
    return messageType === "calllogmessage" || messageType === "call";
}
function isStatusQuestion(text = "") {
    return STATUS_CONTEXT_RE.test(String(text || ""));
}
function runtimeUnavailableReply(ctx) {
    if (!isStatusQuestion(ctx.text))
        return null;
    if (ctx.runtimeStatus)
        return null;
    return ctx.language === "kk"
        ? "Қазір асүй статусын тексере алмаймын. Кейін қайталап жазыңыз."
        : "Не могу проверить статус кухни. Напишите позже.";
}
function unavailableOrderReply(language) {
    return language === "ru"
        ? "Не удалось получить актуальный статус заказа. Попробуйте немного позже."
        : "Тапсырыстың өзекті статусын ала алмадым. Сәл кейінірек қайталап көріңіз.";
}
function missingOrderReply(language) {
    return language === "ru"
        ? "Активный заказ по этому номеру не найден. Отправьте номер заказа."
        : "Бұл нөмір бойынша белсенді тапсырыс табылмады. Тапсырыс нөмірін жіберіңіз.";
}
async function customerOrderReply(ctx) {
    // "заказ 59 холодный привезли" names an order, but the guest is not asking where it is —
    // they are angry about it. Answering with a status line would bury a real
    // complaint and never raise the operator flag, so anger and human requests
    // are left to the escalation path further down instead of being short-circuited here.
    if (isLikelyComplaintText(ctx.text) || isLikelyOperatorRequestText(ctx.text))
        return null;
    const timingAsked = Boolean(ctx.activeOrder)
        && isOrderTimingQuestion(ctx.text)
        && !isProspectiveOrderTimingQuestion(ctx.text);
    if (!isCustomerOrderStatusQuestion(ctx.text) && !(ctx.activeOrder && isLikelyOrderStatusFollowUp(ctx.text)) && !timingAsked)
        return null;
    const orderNumber = requestedOrderNumber(ctx.text);
    const discussedNumber = orderNumber ? "" : lastDiscussedOrderNumber(ctx.chatHistory);
    const discussedRecord = discussedNumber ? pickConversationOrder(ctx.activeOrder, discussedNumber) : null;
    const lookup = orderNumber
        ? await getCustomerOrder(ctx.instanceId, String(ctx.config?.domain || ""), ctx.phone, ctx.language, orderNumber)
        : ctx.activeOrder?.is_stale
            ? { state: "unavailable" }
            : customerOrderFromRecord(discussedRecord || ctx.activeOrder, ctx.phone, ctx.language);
    if (lookup.state === "found")
        return formatCustomerOrderStatus(lookup.order, ctx.language);
    if (lookup.state === "unavailable")
        return unavailableOrderReply(ctx.language);
    return missingOrderReply(ctx.language);
}
function operationalPreemptionReply(ctx) {
    // A text claim is not proof of payment. Asking for the receipt here avoids an
    // unnecessary model call and, critically, cannot mutate the order to paid or
    // accidentally send the menu link again.
    if (!ctx.mediaContext && isUnverifiedPaymentClaim(ctx.text)) {
        return buildUnverifiedPaymentClaimReply(ctx.language);
    }
    // Active operator notes outrank the ordering/link intent. This deterministic
    // check covers compound phrases such as "is Futomaki available, can I order?"
    // where the link tool previously hid the unavailable-item warning.
    const blockedItem = findBlockedMenuItemMention(ctx.activeShiftNotes, Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [], ctx.text);
    return blockedItem ? buildBlockedMenuItemReply(blockedItem, ctx.language) : null;
}
// busyKitchenReply used to hard-code the "we are busy, do you agree to wait?"
// sentence, but nothing has called it since the busy kitchen became a context
// fact (operational_runtime.wait_consent_required + wait_label) that the agent
// phrases itself in its own words. Removed so there is exactly one owner of
// that message and no dead template can silently come back.
function closedKitchenReply(policy, language) {
    if (language === "ru") {
        if (policy.mode === "vacation")
            return `Сейчас временно не принимаем заказы${policy.remainingDays ? ` примерно ${policy.remainingDays} дн.` : ""}. Напишите нам немного позже — мы сообщим актуальную информацию. Спасибо за понимание.`;
        if (policy.mode === "indefinite")
            return "По важной технической причине временно не принимаем заказы. Пожалуйста, напишите нам немного позже, чтобы уточнить актуальную ситуацию. Спасибо за понимание.";
        return "По важной технической причине временно не принимаем заказы. Пожалуйста, попробуйте написать нам немного позже. Спасибо за понимание.";
    }
    if (policy.mode === "vacation")
        return `Қазір уақытша тапсырыс қабылдамаймыз${policy.remainingDays ? `, шамамен ${policy.remainingDays} күн` : ""}. Біраздан кейін қайта жазып, өзекті жағдайды нақтылап көріңіз. Түсіністік танытқаныңызға рақмет.`;
    if (policy.mode === "indefinite")
        return "Маңызды техникалық себепке байланысты уақытша тапсырыс қабылдамаймыз. Біраздан кейін қайта жазып, өзекті жағдайды нақтылап көріңіз. Түсіністік танытқаныңызға рақмет.";
    return "Маңызды техникалық себепке байланысты уақытша тапсырыс қабылдамаймыз. Біраздан кейін қайта жазып көріңіз. Түсіністік танытқаныңызға рақмет.";
}
function unavailableChannelReply(channel, language) {
    if (language === "ru")
        return channel === "delivery" ? "Сейчас доставка временно недоступна, но можно оформить самовывоз." : "Сейчас самовывоз временно недоступен, но можно оформить доставку.";
    return channel === "delivery" ? "Қазір жеткізу уақытша қолжетімсіз, бірақ алып кетуге тапсырыс бере аласыз." : "Қазір алып кету уақытша қолжетімсіз, бірақ жеткізуге тапсырыс бере аласыз.";
}
function missedCallReply(language, brandName) {
    if (language === "ru") {
        const intro = brandName ? `помощник ${brandName}` : "ваш помощник";
        return `Здравствуйте! К сожалению, не можем ответить на звонок. Я — ${intro} 😊 Чем могу помочь? Напишите — слушаю вас!`;
    }
    const intro = brandName ? `${brandName} көмекшісімін` : "сіздің көмекшіңізбін";
    return `Сәлеметсізбе! Қоңырауға жауап бере алмаймыз. Мен — ${intro} 😊 Қандай сұрағыңыз бар? Жазыңыз, сізге көмектесуге дайынмын!`;
}
async function kitchenGateReply(ctx) {
    // An existing order does not silence the kitchen. Questions ABOUT that order
    // are already answered above by customerOrderReply, so anything reaching here
    // is new intent, and new intent must hear the kitchen's real state. Repetition
    // is prevented by consent memory below, not by muting the gate.
    const policy = classifyKitchenSalesPolicy(ctx.runtimeStatus);
    // A guest who already has the link is left to finish, but only while the
    // kitchen is what it was when they got it. A real change reopens the gate.
    const pending = await getPendingKitchenConsent(ctx.instanceId, ctx.phone).catch(() => null);
    if (pending) {
        if (pending.policyFingerprint !== policy.fingerprint)
            await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
        else {
            const answer = detectKitchenConsentAnswer(ctx.text);
            if (answer === "yes") {
                await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
                // The guest accepted this exact kitchen state. Remember it, so the wait
                // is raised once and never turns into nagging on every message.
                await markKitchenCheckoutStarted(ctx.instanceId, ctx.phone, policy.fingerprint).catch(() => false);
                return null;
            }
            if (answer === "no") {
                await clearPendingKitchenConsent(ctx.instanceId, ctx.phone);
                return ctx.language === "ru"
                    ? "Понимаю, извините за ожидание. Тогда заказ сейчас не оформляем. Будем рады видеть вас позже — просто напишите нам."
                    : "Түсіндім, күттіргеніміз үшін кешіріңіз. Онда қазір тапсырысты рәсімдемей тұрайық. Кейінірек жазсаңыз, қуана қабылдаймыз.";
            }
            // Neither yes nor no: the guest is still talking. Let the agent answer
            // them; the consent stays owed and FACTS_CONTEXT still carries it.
            return null;
        }
    }
    if (policy.blocksAllSales)
        return closedKitchenReply(policy, ctx.language);
    const channel = detectRequestedServiceChannel(ctx.text);
    if (channel === "delivery" && !policy.delivery)
        return unavailableChannelReply(channel, ctx.language);
    if (channel === "pickup" && !policy.pickup)
        return unavailableChannelReply(channel, ctx.language);
    // A guest who already accepted this same kitchen state is left to finish.
    // Only a real change of the kitchen reopens the gate.
    const checkoutFingerprint = await getKitchenCheckoutFingerprint(ctx.instanceId, ctx.phone).catch(() => null);
    if (checkoutFingerprint && checkoutFingerprint === policy.fingerprint)
        return null;
    // The delay is the operator's promise to the guest, so the code states it
    // rather than hoping the model will. Asked once per kitchen state, in the
    // guest's language, and the answer decides what happens next.
    if (policy.requiresConsent) {
        await savePendingKitchenConsent(ctx.instanceId, ctx.phone, policy.fingerprint);
        const label = formatKitchenWait(policy.waitMinutes || 0, ctx.language === "ru" ? "ru" : "kk");
        return ctx.language === "ru"
            ? `Сейчас заказов много, приготовление займёт примерно ${label}. Сможете подождать? Если да — продолжим заказ.`
            : `Қазір тапсырыс көп, дайындалуы шамамен ${label} болады. Күте аласыз ба? Күтсеңіз, тапсырысты жалғастыра берейін.`;
    }
    return null;
}
function hasMeaningfulMediaDescription(text = "", mediaContext = null) {
    const clean = stripEscalationSignals(text).trim();
    if (!clean || clean === "[Media sent]")
        return false;
    const historyLabel = String(mediaContext?.historyLabel || "").trim();
    if (historyLabel && clean === historyLabel)
        return false;
    return clean.length >= 2;
}
async function sendCustomerReplyAndFinish(ctx, messageId, reply, source) {
    const cleanReply = stripEscalationSignals(reply);
    if (cleanReply) {
        const delivery = await sendWhatsProResponseSequence({
            instanceId: ctx.instanceId,
            phone: ctx.phone,
            text: cleanReply,
            requestScope: messageId,
        });
        if (!delivery.ok)
            throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
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
    let text = extractInboundText(body) ||
        mediaContext?.caption ||
        mediaContext?.historyLabel ||
        (mediaContext ? "[Media sent]" : "");
    let customerLanguageText = extractInboundText(body) || mediaContext?.caption || "";
    let stopTyping = () => { };
    let turnLockOwner = null;
    console.log(`[OPENBOT:INBOUND] received instance=${instanceId || "-"} phone=${maskPhone(phone)} text_len=${String(text || "").length} media=${mediaContext?.kind || "no"} source=${body.source || "-"}`);
    try {
        if (!String(text || "").trim() && !mediaContext) {
            if (isIncomingVoiceCall(body) && instanceId && phone) {
                // Someone rang the bot's WhatsApp number. Reply with a text redirect
                // so the customer knows to write instead of call.
                if (process.env.TEST_MODE_ENABLED === "true") {
                    const devPhone = String(process.env.OPENBOT_DEVELOPER_PHONE || "").replace(/\D/g, "");
                    if (devPhone && phone !== devPhone) {
                        return; // test_mode: only handle developer_phone calls
                    }
                }
                const callConfig = await getRestaurantConfig(instanceId).catch(() => null);
                // callsDisabled=false means the admin re-enabled live calls (future voice assistant).
                // Default (undefined/true) keeps the text-redirect behaviour that was already deployed.
                const callsDisabled = callConfig?.callsDisabled ?? callConfig?.calls_disabled;
                if (callsDisabled === false) {
                    console.log(`[OPENBOT:CALL] calls_enabled_passthrough instance=${instanceId} phone=${maskPhone(phone)}`);
                    return; // admin enabled live calls — let WhatsApp ring through, no text redirect
                }
                const callLang = (["ru", "russian"].includes(String(callConfig?.language || "").toLowerCase()) ? "ru" : "kk");
                const callBrand = String(callConfig?.brand || "").trim() || undefined;
                await sendWhatsProResponseSequence({
                    instanceId,
                    phone,
                    text: missedCallReply(callLang, callBrand),
                    requestScope: messageId || `call:${phone}:${Date.now()}`,
                }).catch((err) => console.warn(`[OPENBOT:CALL] reply_failed instance=${instanceId} phone=${maskPhone(phone)}`, err?.message || err));
                console.log(`[OPENBOT:CALL] missed_call_replied instance=${instanceId} phone=${maskPhone(phone)} lang=${callLang} elapsed=${Date.now() - started}ms`);
            }
            else {
                console.log(`[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=empty_message elapsed=${Date.now() - started}ms`);
            }
            return;
        }
        if (!(await isTenantBotEnabled(instanceId))) {
            await markInboundDone(instanceId, messageId).catch(() => undefined);
            console.log(`[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=bot_paused elapsed=${Date.now() - started}ms`);
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
            console.log(`[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=${guard.reason || "blocked"} elapsed=${Date.now() - started}ms`);
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
        // Merge fragmented text messages in a small, short-lived Redis buffer.
        if (!mediaContext && text) {
            const buffered = await bufferInboundText({ instanceId, phone, messageId, text });
            if (!buffered.leader) {
                await markInboundDone(instanceId, messageId);
                return;
            }
            // One conversation = one reply at a time. The per-message lock never
            // stopped two batches of split messages from being answered in parallel;
            // this turn lock does. A part that arrives while the previous reply is
            // still being generated waits a bounded moment, then gets folded into
            // ONE coherent message by the buffer brain - never a second answer.
            turnLockOwner = await acquireTurnLock(instanceId, phone);
            for (let waited = 0; !turnLockOwner && waited < 20_000; waited += 1_500) {
                await new Promise((resolve) => setTimeout(resolve, 1_500));
                turnLockOwner = await acquireTurnLock(instanceId, phone);
            }
            if (!turnLockOwner) {
                console.warn(`[OPENBOT:BUFFER] turn busy, part deferred instance=${instanceId} phone=${maskPhone(phone)}`);
                await markInboundDone(instanceId, messageId);
                return;
            }
            const leftovers = await drainInboundBuffer(instanceId, phone).catch(() => []);
            const parts = [...buffered.items, ...leftovers].filter(Boolean);
            text = parts.length > 1
                ? await mergeBufferedParts(parts).catch(() => buffered.text || text)
                : (parts[0] || buffered.text || text);
            customerLanguageText = text;
        }
        mediaContext = await hydrateInboundMedia(body, mediaContext);
        const ctx = await preloadContext({ instanceId, phone, text, languageCandidateText: customerLanguageText, mediaContext, senderMeta });
        console.log(`[OPENBOT:CONTEXT] loaded instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} lang=${ctx.language} domain=${ctx.config?.domain || "-"} runtime=${ctx.runtimeStatus ? "ok" : "missing"} wait=${ctx.hardRealtimeContext.wait_time ?? "-"} order=${ctx.activeOrder?.order_id || "none"} notes=${ctx.activeShiftNotes.length} history=${ctx.chatHistory.length} link_sent=${ctx.magicLinkAlreadySent}`);
        if (mediaContext?.kind === "video") {
            const reply = ctx.language === "ru"
                ? "Извините, я не принимаю видео. Пожалуйста, опишите, что произошло, текстом или отправьте фото."
                : "Кешіріңіз, видео қабылдай алмаймын. Не болғанын мәтінмен түсіндіріңіз немесе фото жіберіңіз.";
            await sendWhatsProResponseSequence({
                instanceId: ctx.instanceId,
                phone: ctx.phone,
                text: reply,
                requestScope: messageId,
            });
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
        let immediateComplaintMedia = null;
        let immediateComplaintUrgency = "normal";
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
            const recentDialog = ctx.chatHistory.slice(-4).map((entry) => `${entry?.role || "user"}: ${String(entry?.text || "").slice(0, 300)}`).join("\n");
            const mediaAnalysis = await analyzeMedia(mediaContext.base64, mediaContext.mimeType || mediaContext.mediaType || "application/octet-stream", `${text}\n\n[RECENT DIALOGUE FOR CONTEXT ONLY]\n${recentDialog}`.slice(0, 1800), ctx.language, (mediaContext.mimeType || "").includes("pdf"), "", receiptContext);
            if (mediaAnalysis) {
                mediaContext = { ...mediaContext, analysis: mediaAnalysis };
                ctx.mediaContext = mediaContext;
                if (mediaAnalysis.type === "receipt") {
                    const strictFilter = receiptFilterEnabled();
                    const validation = validateReceiptAnalysis(mediaAnalysis, receiptContext);
                    if (strictFilter && !validation.valid) {
                        await sendCustomerReplyAndFinish(ctx, messageId, rejectedReceiptReply(ctx.language, validation.reason), `payment_receipt_rejected:${validation.reason}`);
                        return;
                    }
                    const fingerprint = createReceiptFingerprint(String(mediaContext.base64 || ""), mediaAnalysis);
                    if (!(await claimReceiptFingerprint(ctx.instanceId, fingerprint))) {
                        const duplicateReply = ctx.language === "ru"
                            ? "Этот чек уже был отправлен. Пожалуйста, не отправляйте один чек повторно."
                            : "Бұл чек бұрын жіберілген. Бір чекті қайта жібермеңіз.";
                        await sendCustomerReplyAndFinish(ctx, messageId, duplicateReply, "payment_receipt_duplicate");
                        return;
                    }
                    const analyzedOrderReference = String(mediaAnalysis.order_id || "").trim();
                    const receiptOrderNumber = analyzedOrderReference && analyzedOrderReference !== "0"
                        ? analyzedOrderReference
                        : String(activeOrder.display_number || activeOrder.order_number || activeOrder.id || activeOrder.order_id || "");
                    const receiptOrder = await getCustomerOrder(ctx.instanceId, String(ctx.config?.domain || ""), ctx.phone, ctx.language, receiptOrderNumber);
                    if (receiptOrder.state !== "found") {
                        await releaseReceiptFingerprint(ctx.instanceId, fingerprint);
                        await sendCustomerReplyAndFinish(ctx, messageId, rejectedReceiptReply(ctx.language, "order_not_found"), "payment_receipt_order_not_found");
                        return;
                    }
                    const delivery = await deliverReceiptToClient({
                        instanceId: ctx.instanceId,
                        phone: ctx.phone,
                        orderNumber: receiptOrder.order.orderId,
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
                    if (!delivery.success) {
                        await releaseReceiptFingerprint(ctx.instanceId, fingerprint);
                        const retryReply = ctx.language === "ru"
                            ? "Не удалось передать чек оператору. Пожалуйста, отправьте его ещё раз чуть позже."
                            : "Чекті операторға жібере алмадым. Сәлден кейін қайта жіберіңіз.";
                        await sendCustomerReplyAndFinish(ctx, messageId, retryReply, "payment_receipt_crm_failed");
                        return;
                    }
                    const receiptReply = ctx.language === "ru"
                        ? "🧾 Большое спасибо за оплату! Чек отправлен оператору на проверку. Пожалуйста, немного подождите ⏳"
                        : "🧾 Төлеміңіз үшін көп рақмет! Чек операторға тексеруге жіберілді. Кішкене күте тұрыңыз ⏳";
                    await sendCustomerReplyAndFinish(ctx, messageId, receiptReply, "payment_receipt");
                    return;
                }
                if (mediaAnalysis.type === "technical_error") {
                    mediaDeveloperError = mediaAnalysis.analysis || "media_analysis_failed";
                    mediaPreemptiveReply =
                        mediaAnalysis.reply_to_customer ||
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
                    }
                    else {
                        immediateComplaintSummary = mediaAnalysis.admin_summary || mediaAnalysis.analysis || text;
                        immediateComplaintMedia = {
                            base64: mediaContext.base64,
                            mimeType: mediaContext.mimeType || mediaContext.mediaType || "image/jpeg",
                        };
                        immediateComplaintUrgency = "high";
                        mediaPreemptiveReply =
                            mediaAnalysis.reply_to_customer ||
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
        console.log(`[OPENBOT:AI] completed chars=${result.text.length} finish=${result.finishReason || "-"} link=${result.hasLink}` +
            ` planned_tools=${result.toolPlan.requiredTools.join(",") || "auto"}` +
            ` called_tools=${result.toolCalls.map((call) => call.name).join(",") || "none"}` +
            ` validator=${result.validationWarnings.join(",") || "clean"}`);
        if (result.thinking)
            void bumpMetric(ctx.instanceId, "think_used");
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
            if (result.validationWarnings.some((warning) => ["empty_model_output", "foreign_script_output"].includes(warning))) {
                void bumpMetric(ctx.instanceId, "fallbacks");
                void recordLearningEvent(ctx.instanceId, {
                    type: "fallback_reply",
                    detail: result.validationWarnings.slice(0, 5).join(","),
                    phone: maskPhone(ctx.phone),
                });
            }
        }
        const rawAiText = String(result.rawText || result.text || "");
        const needsAdminEscalation = hasEscalateAdminSignal(rawAiText) || hasEscalateAdminSignal(result.text);
        const pendingComplaintMedia = await hasPendingComplaintMedia(ctx.instanceId, ctx.phone);
        // Asking for a human is not a complaint to investigate — hand it over at
        // once. A complaint gets one calm question when it names nothing yet, and
        // the pending flag makes the next message escalate whatever it contains.
        const askedForOperator = isLikelyOperatorRequestText(ctx.text);
        const complaintText = isLikelyComplaintText(ctx.text);
        const awaitingDetail = await takeComplaintClarification(ctx.instanceId, ctx.phone);
        const complaintNeedsDetail = complaintText && !askedForOperator && !needsAdminEscalation && !pendingComplaintMedia
            && awaitingDetail === null && !complaintHasActionableDetail(ctx.text);
        const shouldRouteComplaint = !complaintNeedsDetail
            && (needsAdminEscalation || pendingComplaintMedia || askedForOperator || complaintText || awaitingDetail !== null);
        if (complaintNeedsDetail) {
            await markComplaintClarificationPending(ctx.instanceId, ctx.phone, ctx.text).catch(() => false);
        }
        const finalText = stripEscalationSignals(result.text)
            || (complaintNeedsDetail ? buildComplaintDetailQuestion(ctx.language) : shouldRouteComplaint ? buildComplaintAckReply(ctx.language) : result.text);
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
        // Outbound duplicate guard: an identical reply sent within the last
        // 60s (parallel turn, retried webhook) is dropped instead of shown twice.
        const outboundIsNew = await claimOutboundReply(ctx.instanceId, ctx.phone, finalText).catch(() => true);
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
        });
        if (!sendResult.ok)
            throw new Error("WHATSPRO_SEQUENCE_NOT_ACKNOWLEDGED");
        await saveToHistory(ctx.instanceId, ctx.phone, "assistant", finalText, { source: "openbot-agent", ...noteHistoryMeta(ctx, finalText) });
        await markInboundDone(ctx.instanceId, messageId);
        await bumpOperatorCaseSignal(ctx.instanceId, ctx.phone).catch(() => false);
        // Sweep leftovers from the burst we just answered so they cannot become a
        // second reply; genuinely new messages flush their own batch anyway.
        void drainInboundBuffer(ctx.instanceId, ctx.phone).catch(() => []);
        // The customer's mission advances only after their reply is safely out.
        // Fire-and-forget: one tiny Redis value, never on the latency path.
        void updateGoalAfterTurn({
            ctx,
            analysis: result.thinking || null,
            escalated: shouldRouteComplaint ||
                result.toolCalls.some((call) => call.name === "escalateToAdmin"),
        }).catch(() => undefined);
        void recordLatency(ctx.instanceId, Date.now() - started);
        if (result.hasLink)
            void bumpMetric(ctx.instanceId, "links_sent");
        // Memory is written only after the customer already has the reply, so it can
        // never add latency to the answer and can never fail the request. The trace
        // is what makes the agent self-aware on the next turn; the profile/summary
        // refresh is what makes it remember this customer at all.
        void recordTurnTrace({
            instanceId: ctx.instanceId,
            phone: ctx.phone,
            trace: {
                tools: result.toolCalls.map((call) => call.name),
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
        console.log(`[OPENBOT:OUTBOUND] sent instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} chunks=${sendResult.chunks || 0} ok=${Boolean(sendResult?.ok)} link_in_text=${result.hasLink} elapsed=${Date.now() - started}ms`);
    }
    catch (error) {
        await clearInboundProcessing(String(instanceId || ""), messageId).catch(() => undefined);
        await notifyDeveloperSystemFailure(String(instanceId || ""), error, {
            scope: "whatsapp_webhook",
            messageId,
            customerPhone: maskPhone(phone),
        }).catch(() => undefined);
        throw error;
    }
    finally {
        stopTyping();
        if (turnLockOwner) {
            void releaseTurnLock(instanceId, phone, turnLockOwner).catch(() => undefined);
            turnLockOwner = null;
        }
    }
}
export function whatsappWebhookRoute() {
    const router = createRouter();
    router.post("/", resolveTenantInstance, verifySecret, async (req, res) => {
        const started = Date.now();
        const body = req.body || {};
        console.info(`[OPENBOT:WEBHOOK] fromMe=${isOwnWhatsAppMessage(body)} instance=${getInstanceId(body) || "-"} phone=${maskPhone(getPhone(body))}`);
        if (isOwnWhatsAppMessage(body)) {
            const instanceId = getInstanceId(body);
            const phone = getPhone(body);
            const opText = extractInboundText(body) || "[Оператор сөйледі]";
            await setOperatorAutoMute(instanceId, phone).catch((error) => {
                console.warn("[OPENBOT:OPERATOR:MUTE:FAIL]", error?.message || error);
                void notifyDeveloperSystemFailure(instanceId, error, {
                    scope: "operator_auto_mute",
                    customerPhone: maskPhone(phone),
                }).catch(() => undefined);
            });
            if (instanceId && phone && opText) {
                await saveToHistory(instanceId, phone, "operator", opText, { source: "operator_from_me" }).catch((error) => {
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
        const text = extractInboundText(body) ||
            mediaContext?.caption ||
            mediaContext?.historyLabel ||
            (mediaContext ? "[Media sent]" : "");
        if (!String(text || "").trim() && !mediaContext) {
            console.log(`[OPENBOT:INBOUND:SKIP] instance=${getInstanceId(body) || "-"} phone=${maskPhone(getPhone(body))} reason=empty_message elapsed=${Date.now() - started}ms`);
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

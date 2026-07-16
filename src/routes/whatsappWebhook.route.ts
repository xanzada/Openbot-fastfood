import type { Router } from "express";
import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import { saveComplaintMedia, saveToHistory } from "../services/redis.service.js";
import {
  buildComplaintAckReply,
  buildComplaintClarificationReply,
  hasEscalateAdminSignal,
  hasEscalateDeveloperSignal,
  hasPendingComplaintMedia,
  isLikelyComplaintText,
  routeComplaintToAdmin,
  stripEscalationSignals,
  type ComplaintMediaPayload,
  type ComplaintUrgency,
} from "../services/complaintRouting.service.js";
import {
  clearInboundProcessing,
  extractInboundMedia,
  extractSenderMeta,
  extractInboundText,
  extractMessageId,
  guardIncomingMessage,
  hydrateInboundMedia,
  markInboundDone,
  saveMediaContext,
  setOperatorAutoMute,
} from "../services/inboundGuard.service.js";
import { syncKanbanEvent } from "../services/kanbanSync.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { sendWhatsProResponseSequence } from "../transport/whatspro.client.js";
import { getPhoneCandidatesFromWebhook, normalizePhoneFromCandidates, updateCrmAction } from "../services/dle.service.js";
import { evaluateForShpor, getRestaurantConfig, saveToShpor } from "../services/nocodb.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import { analyzeMedia } from "../services/mediaAnalysis.service.js";
import type { FastFoodContext } from "../context/types.js";

const STATUS_CONTEXT_RE = /(асүй|ас үй|кухн|kitchen|повар|cook|статус|status|ашылды ма|жабық па|жұмыс істеп жатыр|работает|открыт|закрыт|готов|дайын)/iu;

function maskPhone(phone = "") {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length <= 6) return clean || "-";
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

function getInstanceId(body: any) {
  return String(body?.instanceId || body?.instance || body?.restaurant_id || "").trim();
}

function getPhone(body: any) {
  const eventData = body?.data || body || {};
  const key = eventData?.key || body?.key || {};
  return normalizePhoneFromCandidates(getPhoneCandidatesFromWebhook(body || {}, eventData, key));
}

async function verifySecret(req: any, res: any, next: any) {
  const expected = process.env.OPENBOT_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN;
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
    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", cleanReply, {
      source,
    });
    await sendWhatsProResponseSequence({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      text: cleanReply,
    });
  }
  await markInboundDone(ctx.instanceId, messageId);
}

async function processWhatsAppWebhook(body: any, started: number) {
  const instanceId = getInstanceId(body);
  const phone = getPhone(body);
  const messageId = extractMessageId(body);
  let mediaContext = extractInboundMedia(body);
  const senderMeta = extractSenderMeta(body);
  const text =
    extractInboundText(body) ||
    mediaContext?.caption ||
    mediaContext?.historyLabel ||
    (mediaContext ? "[Media sent]" : "");

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
          media: mediaContext,
        });
      }
      console.log(
        `[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=${guard.reason || "blocked"} elapsed=${Date.now() - started}ms`
      );
      return;
    }

    mediaContext = await hydrateInboundMedia(body, mediaContext);
    const ctx = await preloadContext({ instanceId, phone, text, mediaContext, senderMeta });
    console.log(
      `[OPENBOT:CONTEXT] loaded instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} lang=${ctx.language} domain=${ctx.config?.domain || "-"} runtime=${ctx.runtimeStatus ? "ok" : "missing"} wait=${ctx.hardRealtimeContext.wait_time ?? "-"} order=${ctx.activeOrder?.order_id || "none"} notes=${ctx.activeShiftNotes.length} history=${ctx.chatHistory.length} link_sent=${ctx.magicLinkAlreadySent}`
    );

    if (mediaContext?.kind === "video") {
      const reply =
        ctx.language === "ru"
          ? "Извините, я не принимаю видео. Пожалуйста, опишите ситуацию текстом."
          : "Кешіріңіз, видео қабылдай алмаймын. Жағдайды мәтінмен жазыңыз.";
      await sendWhatsProResponseSequence({ instanceId: ctx.instanceId, phone: ctx.phone, text: reply });
      await markInboundDone(ctx.instanceId, messageId);
      return;
    }

    let mediaPreemptiveReply = "";
    let mediaPreemptiveSource = "";
    let mediaDeveloperError = "";
    let immediateComplaintSummary = "";
    let immediateComplaintMedia: ComplaintMediaPayload | null = null;
    let immediateComplaintUrgency: ComplaintUrgency = "normal";

    if (mediaContext?.base64 && mediaContext.valid) {
      const mediaAnalysis = await analyzeMedia(
        mediaContext.base64,
        mediaContext.mimeType || mediaContext.mediaType || "application/octet-stream",
        text,
        ctx.language,
        (mediaContext.mimeType || "").includes("pdf")
      );
      if (mediaAnalysis) {
        mediaContext = { ...mediaContext, analysis: mediaAnalysis };
        ctx.mediaContext = mediaContext;
        if (mediaAnalysis.type === "receipt") {
          await updateCrmAction("receipt", ctx.instanceId, ctx.phone, {
            config: ctx.config,
            amount: mediaAnalysis.amount,
            amount_paid: mediaAnalysis.amount,
            sender_name: mediaAnalysis.sender_name,
            sender: mediaAnalysis.sender_name,
            bank_name: mediaAnalysis.bank_name,
            order_id: mediaAnalysis.order_id,
            date_time: mediaAnalysis.date_time,
          }).catch(() => null);

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
      media: mediaContext,
    });

    if (mediaContext) {
      await saveMediaContext(ctx.instanceId, ctx.phone, mediaContext);
    }

    await saveToHistory(ctx.instanceId, ctx.phone, "user", ctx.text, {
      source: "openbot-agent",
      media: mediaContext,
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
      await saveToHistory(ctx.instanceId, ctx.phone, "system", "complaint routed to admin", {
        source: "complaint-routing",
        adminPhone: routing.adminPhone,
        mediaAttached: routing.mediaAttached,
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

    // Pre-LLM short-circuit: if runtime is unavailable and customer asks about kitchen
    const runtimeReply = runtimeUnavailableReply(ctx);
    if (runtimeReply) {
      console.log(`[OPENBOT:PREEMPT] runtime unavailable, using fallback`);
      await saveToHistory(ctx.instanceId, ctx.phone, "assistant", runtimeReply, {
        source: "openbot-agent",
      });
      await sendWhatsProResponseSequence({
        instanceId: ctx.instanceId,
        phone: ctx.phone,
        text: runtimeReply,
      });
      await markInboundDone(ctx.instanceId, messageId);
      return;
    }

    console.log(`[OPENBOT:AI] generating model=${process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash"}`);
    const result = await runFastFoodAgent(ctx);
    console.log(`[OPENBOT:AI] completed chars=${result.text.length} finish=${result.finishReason || "-"} link=${result.hasLink}`);

    const rawAiText = String(result.rawText || result.text || "");
    const needsDeveloperEscalation = hasEscalateDeveloperSignal(rawAiText) || hasEscalateDeveloperSignal(result.text);
    const needsAdminEscalation = hasEscalateAdminSignal(rawAiText) || hasEscalateAdminSignal(result.text);
    const pendingComplaintMedia = await hasPendingComplaintMedia(ctx.instanceId, ctx.phone);
    const shouldRouteComplaint = needsAdminEscalation || pendingComplaintMedia || isLikelyComplaintText(ctx.text);
    const finalText =
      stripEscalationSignals(result.text) || (shouldRouteComplaint ? buildComplaintAckReply(ctx.language) : result.text);

    if (needsDeveloperEscalation) {
      await notifyDeveloperSystemFailure(ctx.instanceId, new Error("AI requested developer escalation"), {
        scope: "ai-router",
        messageId,
        customerPhone: maskPhone(ctx.phone),
      }).catch(() => undefined);
    }

    if (shouldRouteComplaint) {
      const routing = await routeComplaintToAdmin(ctx, {
        summary: stripEscalationSignals(rawAiText || finalText || ctx.text),
        customerText: ctx.text,
        customerReply: finalText,
        urgency: needsAdminEscalation ? "high" : "normal",
        source: needsAdminEscalation ? "ai_escalation_signal" : pendingComplaintMedia ? "pending_complaint_media" : "complaint_text",
      });
      await saveToHistory(ctx.instanceId, ctx.phone, "system", "complaint routed to admin", {
        source: "complaint-routing",
        adminPhone: routing.adminPhone,
        mediaAttached: routing.mediaAttached,
      });
      if (!routing.escalationAvailable) {
        await notifyDeveloperSystemFailure(ctx.instanceId, new Error("ADMIN_PHONE_NOT_CONFIGURED_FOR_COMPLAINT"), {
          scope: "complaint-routing",
          messageId,
          customerPhone: maskPhone(ctx.phone),
        }).catch(() => undefined);
      }
    }

    await saveToHistory(ctx.instanceId, ctx.phone, "assistant", finalText, {
      source: "openbot-agent",
    });

    void evaluateForShpor(ctx.text, finalText)
      .then((evaluation) => {
        if (evaluation.save) {
          return saveToShpor(ctx.instanceId, ctx.text, finalText, evaluation.category || "faq", evaluation.memory || null);
        }
        return undefined;
      })
      .catch((error) => {
        console.warn("[SHPOR:EVAL] async save skipped:", error?.message || error);
      });

    // Send main text response
    const sendResult = await sendWhatsProResponseSequence({
      instanceId: ctx.instanceId,
      phone: ctx.phone,
      text: finalText,
    });

    await markInboundDone(ctx.instanceId, messageId);
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
  }
}

export function whatsappWebhookRoute(): Router {
  const router = createRouter();

  router.post("/webhook/whatsapp", verifySecret, async (req, res) => {
    const started = Date.now();
    const body = req.body || {};
    console.info(
      `[OPENBOT:WEBHOOK] POST /webhook/whatsapp fromMe=${isOwnWhatsAppMessage(body)} instance=${getInstanceId(body) || "-"} phone=${maskPhone(getPhone(body))}`
    );

    if (isOwnWhatsAppMessage(body)) {
      const instanceId = getInstanceId(body);
      const phone = getPhone(body);
      const opText = extractInboundText(body) || "[Оператор сөйледі]";
      await setOperatorAutoMute(instanceId, phone).catch((error: any) => {
        console.warn("[OPENBOT:OPERATOR:MUTE:FAIL]", error?.message || error);
      });
      if (instanceId && phone && opText) {
        await saveToHistory(instanceId, phone, "operator", opText, { source: "operator_from_me" }).catch((error: any) => {
          console.warn("[OPENBOT:OPERATOR:HISTORY:FAIL]", error?.message || error);
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

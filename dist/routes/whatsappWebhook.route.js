import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import { saveComplaintMedia, saveToHistory } from "../services/redis.service.js";
import { clearInboundProcessing, extractInboundMedia, extractSenderMeta, extractInboundText, extractMessageId, guardIncomingMessage, hydrateInboundMedia, markInboundDone, saveMediaContext, setOperatorAutoMute, } from "../services/inboundGuard.service.js";
import { syncKanbanEvent } from "../services/kanbanSync.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { sendWhatsProResponseSequence } from "../transport/whatspro.client.js";
import { getPhoneCandidatesFromWebhook, normalizePhoneFromCandidates } from "../services/dle.service.js";
import { evaluateForShpor, getRestaurantConfig, saveToShpor } from "../services/nocodb.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import { analyzeMedia } from "../services/mediaAnalysis.service.js";
function maskPhone(phone = "") {
    const clean = String(phone || "").replace(/\D/g, "");
    if (clean.length <= 6)
        return clean || "-";
    return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}
function getInstanceId(body) {
    return String(body?.instanceId || body?.instance || body?.restaurant_id || "").trim();
}
function getPhone(body) {
    const eventData = body?.data || body || {};
    const key = eventData?.key || body?.key || {};
    return normalizePhoneFromCandidates(getPhoneCandidatesFromWebhook(body || {}, eventData, key));
}
async function verifySecret(req, res, next) {
    const expected = process.env.OPENBOT_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN;
    const got = req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
        req.headers["x-api-key"] ||
        req.body?.token;
    if (expected && safeCompare(got, expected))
        return next();
    try {
        const instanceId = getInstanceId(req.body || {});
        if (!instanceId)
            throw new Error("INVALID_TENANT_SECRET");
        const config = await getRestaurantConfig(instanceId);
        assertTenantSecret(req, config, "webhook");
        return next();
    }
    catch (error) {
        console.warn(`[OPENBOT:AUTH:FAIL] path=${req.path} reason=${error?.message || "bad_token"}`);
        return res.status(error?.statusCode || 401).json({ ok: false, error: "unauthorized" });
    }
}
function isOwnWhatsAppMessage(body) {
    return body?.fromMe === true || body?.isFromMe === true || body?.data?.key?.fromMe === true;
}
async function processWhatsAppWebhook(body, started) {
    const instanceId = getInstanceId(body);
    const phone = getPhone(body);
    const messageId = extractMessageId(body);
    let mediaContext = await hydrateInboundMedia(body, extractInboundMedia(body));
    const senderMeta = extractSenderMeta(body);
    const text = extractInboundText(body) ||
        mediaContext?.caption ||
        mediaContext?.historyLabel ||
        (mediaContext ? "[Media sent]" : "");
    console.log(`[OPENBOT:INBOUND] received instance=${instanceId || "-"} phone=${maskPhone(phone)} text_len=${String(text || "").length} media=${mediaContext?.kind || "no"} source=${body.source || "-"}`);
    try {
        const guard = await guardIncomingMessage({
            instanceId,
            phone,
            text,
            messageId,
            fromMe: isOwnWhatsAppMessage(body),
            senderMeta,
        });
        if (guard.blocked) {
            if (guard.source === "operator_override") {
                await saveToHistory(String(instanceId || ""), String(phone || ""), "user", text || mediaContext?.historyLabel || "[operator override]", {
                    source: "operator_override",
                    media: mediaContext,
                });
            }
            console.log(`[OPENBOT:INBOUND:SKIP] instance=${instanceId || "-"} phone=${maskPhone(phone)} reason=${guard.reason || "blocked"} elapsed=${Date.now() - started}ms`);
            return;
        }
        const ctx = await preloadContext({ instanceId, phone, text, mediaContext, senderMeta });
        console.log(`[OPENBOT:CONTEXT] loaded instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} lang=${ctx.language} domain=${ctx.config?.domain || "-"} runtime=${ctx.runtimeStatus ? "ok" : "missing"} wait=${ctx.hardRealtimeContext.wait_time ?? "-"} order=${ctx.activeOrder?.order_id || "none"} notes=${ctx.activeShiftNotes.length} history=${ctx.chatHistory.length} link_sent=${ctx.magicLinkAlreadySent}`);
        if (mediaContext?.kind === "video") {
            const reply = ctx.language === "ru"
                ? "Извините, я не принимаю видео. Пожалуйста, опишите ситуацию текстом или аудио."
                : "Кешіріңіз, видео қабылдай алмаймын. Қандай жағдай болғанын мәтінмен немесе аудиомен айтсаңыз.";
            await sendWhatsProResponseSequence({ instanceId: ctx.instanceId, phone: ctx.phone, text: reply });
            await markInboundDone(ctx.instanceId, messageId);
            return;
        }
        if (mediaContext?.base64 && mediaContext.valid) {
            const mediaAnalysis = await analyzeMedia(mediaContext.base64, mediaContext.mimeType || mediaContext.mediaType || "application/octet-stream", text, ctx.language, (mediaContext.mimeType || "").includes("pdf"));
            if (mediaAnalysis) {
                mediaContext = { ...mediaContext, analysis: mediaAnalysis };
                ctx.mediaContext = mediaContext;
                if (mediaAnalysis.type === "complaint" && mediaContext.base64) {
                    await saveComplaintMedia(ctx.instanceId, ctx.phone, mediaContext.base64, mediaContext.mimeType || mediaContext.mediaType || "image/jpeg");
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
        console.log(`[OPENBOT:AI] generating model=${process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash"}`);
        const result = await runFastFoodAgent(ctx);
        console.log(`[OPENBOT:AI] completed chars=${result.text.length} finish=${result.finishReason || "-"}`);
        await saveToHistory(ctx.instanceId, ctx.phone, "assistant", result.text, {
            source: "openbot-agent",
        });
        void evaluateForShpor(ctx.text, result.text)
            .then((evaluation) => {
            if (evaluation.save) {
                return saveToShpor(ctx.instanceId, ctx.text, result.text, evaluation.category || "faq", evaluation.memory || null);
            }
            return undefined;
        })
            .catch((error) => {
            console.warn("[SHPOR:EVAL] async save skipped:", error?.message || error);
        });
        const sendResult = await sendWhatsProResponseSequence({
            instanceId: ctx.instanceId,
            phone: ctx.phone,
            text: result.text,
        });
        await markInboundDone(ctx.instanceId, messageId);
        console.log(`[OPENBOT:OUTBOUND] sent instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} chunks=${sendResult.chunks || 0} ok=${Boolean(sendResult?.ok)} elapsed=${Date.now() - started}ms`);
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
}
export function whatsappWebhookRoute() {
    const router = createRouter();
    router.post("/webhook/whatsapp", verifySecret, async (req, res) => {
        const started = Date.now();
        if (isOwnWhatsAppMessage(req.body)) {
            const instanceId = getInstanceId(req.body || {});
            const phone = getPhone(req.body || {});
            const opText = extractInboundText(req.body) || "[Оператор сөйледі]";
            await setOperatorAutoMute(instanceId, phone).catch((error) => {
                console.warn("[OPENBOT:OPERATOR:MUTE:FAIL]", error?.message || error);
            });
            if (instanceId && phone && opText) {
                await saveToHistory(instanceId, phone, "operator", opText, { source: "operator_from_me" }).catch((error) => {
                    console.warn("[OPENBOT:OPERATOR:HISTORY:FAIL]", error?.message || error);
                });
            }
            console.log(`[OPENBOT:INBOUND:SKIP] fromMe=true elapsed=${Date.now() - started}ms`);
            return res.status(202).json({ ok: true, skipped: true, reason: "fromMe" });
        }
        res.status(202).json({ ok: true, accepted: true });
        setImmediate(() => {
            void processWhatsAppWebhook(req.body, started).catch((error) => {
                console.error(`[OPENBOT:INBOUND:FAIL] elapsed=${Date.now() - started}ms:`, error?.stack || error?.message || error);
            });
        });
    });
    return router;
}

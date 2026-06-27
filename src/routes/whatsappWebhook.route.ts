import type { Router } from "express";
import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import { saveToHistory } from "../services/redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";

function maskPhone(phone = "") {
  const clean = String(phone || "").replace(/\D/g, "");
  if (clean.length <= 6) return clean || "-";
  return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
}

function verifySecret(req: any, res: any, next: any) {
  const expected = process.env.OPENBOT_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN;
  if (!expected) return next();
  const got =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.headers["x-api-key"] ||
    req.body?.token;
  if (got !== expected) {
    console.warn(`[OPENBOT:AUTH:FAIL] path=${req.path} reason=bad_token`);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  return next();
}

export function whatsappWebhookRoute(): Router {
  const router = createRouter();

  router.post("/webhook/whatsapp", verifySecret, async (req, res) => {
    const started = Date.now();
    try {
      const instanceId = req.body.instanceId || req.body.instance || req.body.restaurant_id;
      const phone = req.body.phone || req.body.senderPhone || req.body.normalizedPhone;
      const text = req.body.text || req.body.message || req.body.body;

      console.log(
        `[OPENBOT:INBOUND] received instance=${instanceId || "-"} phone=${maskPhone(phone)} text_len=${String(text || "").length} source=${req.body.source || "-"}`
      );

      const ctx = await preloadContext({ instanceId, phone, text });
      console.log(
        `[OPENBOT:CONTEXT] loaded instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} lang=${ctx.language} domain=${ctx.config?.domain || "-"} runtime=${ctx.runtimeStatus ? "ok" : "missing"} wait=${ctx.runtimeStatus?.wait_time ?? "-"} order=${ctx.activeOrder?.order_id || "none"} notes=${ctx.activeShiftNotes.length} history=${ctx.chatHistory.length} link_sent=${ctx.magicLinkAlreadySent}`
      );

      await saveToHistory(ctx.instanceId, ctx.phone, "user", ctx.text, {
        source: "openbot-agent",
      });

      console.log(`[OPENBOT:AI] generating model=${process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash"}`);
      const result = await runFastFoodAgent(ctx);
      console.log(`[OPENBOT:AI] completed chars=${result.text.length} finish=${result.finishReason || "-"}`);

      await saveToHistory(ctx.instanceId, ctx.phone, "assistant", result.text, {
        source: "openbot-agent",
      });

      const sendResult = await sendWhatsProMessage({
        instanceId: ctx.instanceId,
        phone: ctx.phone,
        text: result.text,
      });
      console.log(
        `[OPENBOT:OUTBOUND] sent instance=${ctx.instanceId} phone=${maskPhone(ctx.phone)} ok=${Boolean(sendResult?.success ?? sendResult?.ok ?? !sendResult?.skipped)} elapsed=${Date.now() - started}ms`
      );

      res.json({
        ok: true,
        response: result.text,
        send: sendResult,
        model: process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash",
      });
    } catch (error: any) {
      console.error(`[OPENBOT:INBOUND:FAIL] elapsed=${Date.now() - started}ms:`, error?.stack || error?.message || error);
      res.status(500).json({ ok: false, error: error?.message || "openbot failed" });
    }
  });

  return router;
}

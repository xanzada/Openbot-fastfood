import { Router as createRouter } from "express";
import { preloadContext } from "../context/preloadContext.js";
import { runFastFoodAgent } from "../agent/fastfoodAgent.js";
import { saveToHistory } from "../services/redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
function verifySecret(req, res, next) {
    const expected = process.env.OPENBOT_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN;
    if (!expected)
        return next();
    const got = req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
        req.headers["x-api-key"] ||
        req.body?.token;
    if (got !== expected)
        return res.status(401).json({ ok: false, error: "unauthorized" });
    return next();
}
export function whatsappWebhookRoute() {
    const router = createRouter();
    router.post("/webhook/whatsapp", verifySecret, async (req, res) => {
        try {
            const instanceId = req.body.instanceId || req.body.instance || req.body.restaurant_id;
            const phone = req.body.phone || req.body.senderPhone || req.body.normalizedPhone;
            const text = req.body.text || req.body.message || req.body.body;
            const ctx = await preloadContext({ instanceId, phone, text });
            await saveToHistory(ctx.instanceId, ctx.phone, "user", ctx.text, {
                source: "openbot-agent",
            });
            const result = await runFastFoodAgent(ctx);
            await saveToHistory(ctx.instanceId, ctx.phone, "assistant", result.text, {
                source: "openbot-agent",
            });
            const sendResult = await sendWhatsProMessage({
                instanceId: ctx.instanceId,
                phone: ctx.phone,
                text: result.text,
            });
            res.json({
                ok: true,
                response: result.text,
                send: sendResult,
                model: process.env.OPENROUTER_AGENT_MODEL || "google/gemini-2.5-flash",
            });
        }
        catch (error) {
            res.status(500).json({ ok: false, error: error?.message || "openbot failed" });
        }
    });
    return router;
}

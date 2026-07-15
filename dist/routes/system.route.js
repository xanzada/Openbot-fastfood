import { Router as createRouter } from "express";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { getConfigSummary, runDependencyChecks } from "../services/diagnostics.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { handleKanbanWebhook } from "../controllers/kanban.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { normalizePhone } from "../services/dle.service.js";
function verifySecret(channel = "webhook") {
    return async (req, res, next) => {
        const expected = process.env.OPENBOT_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN;
        const got = req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
            req.headers["x-api-key"] ||
            req.body?.token ||
            req.query?.token;
        if (expected && safeCompare(got, expected))
            return next();
        try {
            const instanceId = String(req.body?.instanceId || req.body?.instance || req.body?.restaurant_id || "").trim();
            if (!instanceId)
                return res.status(401).json({ ok: false, error: "unauthorized" });
            const config = await getRestaurantConfig(instanceId);
            assertTenantSecret(req, config, channel);
            return next();
        }
        catch (error) {
            return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
        }
    };
}
function getDeveloperPhone(config = {}) {
    return normalizePhone(config.developer || config.developer_phone || config.dev_phone || process.env.DEVELOPER_PHONE || "");
}
async function notifyKanbanDeveloperSiren(req, error) {
    try {
        const instance = req.body?.instance || req.body?.instanceId || req.body?.restaurant_id || "Белгісіз";
        const orderId = req.body?.order_id || "Белгісіз";
        let config = null;
        if (instance !== "Белгісіз" && /^[a-zA-Z0-9_-]{2,64}$/.test(String(instance))) {
            config = await getRestaurantConfig(String(instance)).catch(() => null);
        }
        const devMsg = `🚨 *CRITICAL DLE KANBAN ERROR!* 🚨\n📍 *Instance:* ${instance}\n📦 *Заказ №:* ${orderId}\n⚠️ *Қате:* ${error?.message || error}\n🛠 *Орны:* kanban.ts\n\nЧек немесе статус клиентке бармай қалды!`;
        const developerPhone = getDeveloperPhone(config || {});
        if (instance !== "Белгісіз") {
            if (developerPhone) {
                await sendWhatsProMessage({ instanceId: String(instance), phone: developerPhone, text: devMsg });
            }
            else {
                console.warn(`[DEV SIREN] ${instance} developer phone not found.`);
            }
        }
    }
    catch (devError) {
        console.error("[DEV SIREN FAILED]:", devError?.message || devError);
    }
}
export function systemRoute() {
    const router = createRouter();
    router.get("/health", (_req, res) => {
        res.json({
            ok: true,
            service: "openbot-agent",
            brain: "VoltAgent",
            stateless_context: true,
        });
    });
    router.get("/health/detailed", async (_req, res) => {
        const checks = await runDependencyChecks();
        const ok = checks.every((check) => check.ok);
        res.status(ok ? 200 : 503).json({
            ok,
            service: "openbot-agent",
            config: getConfigSummary(),
            checks,
        });
    });
    router.post("/kanban-webhook", verifySecret("kanban"), async (req, res) => {
        try {
            await handleKanbanWebhook(req, res);
        }
        catch (error) {
            await notifyKanbanDeveloperSiren(req, error);
            const instanceId = String(req.body?.instanceId || req.body?.instance || req.body?.restaurant_id || "").trim();
            await notifyDeveloperSystemFailure(instanceId, error, {
                scope: "kanban-webhook",
            }).catch(() => undefined);
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: error?.message || "kanban webhook failed" });
            }
        }
    });
    router.post("/api/print_trigger", verifySecret("kanban"), (req, res) => {
        try {
            const io = req.app.get("io");
            const orderData = req.body || {};
            if (io) {
                io.emit("print_new_order", orderData);
                console.log(`[SOCKET] Print signal sent. Order: #${orderData.order_id || orderData.id || "-"}`);
                res.status(200).send({ success: true, message: "Print signal sent to agent" });
            }
            else {
                console.error("[SOCKET] Error: Socket.io (io) not found.");
                res.status(500).send({ success: false, error: "Socket server error" });
            }
        }
        catch (error) {
            const instanceId = String(req.body?.instanceId || req.body?.instance || req.body?.restaurant_id || "").trim();
            void notifyDeveloperSystemFailure(instanceId, error, {
                scope: "print_trigger",
            }).catch(() => undefined);
            if (!res.headersSent) {
                res.status(500).send({ success: false, error: error?.message || "print trigger failed" });
            }
        }
    });
    return router;
}

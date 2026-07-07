import { Router as createRouter } from "express";
import { getPhoneCandidatesFromWebhook, getRuntimeStatus, normalizePhone, normalizePhoneFromCandidates } from "../services/dle.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { deleteShiftNote, saveShiftNote } from "../services/redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { getConfigSummary, runDependencyChecks } from "../services/diagnostics.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
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
            const instanceId = getInstanceId(req.body || {});
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
function getInstanceId(body) {
    return String(body.instanceId || body.instance || body.restaurant_id || "").trim();
}
function getPhone(body) {
    const eventData = body.data || body;
    const key = eventData.key || body.key || {};
    return normalizePhoneFromCandidates(getPhoneCandidatesFromWebhook(body, eventData, key));
}
function paymentDetailsText(details) {
    if (!details.length)
        return "";
    return details
        .map((item) => `${String(item.label || "Реквизит").trim()}: ${String(item.value || "").trim()}`)
        .filter(Boolean)
        .join("\n");
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
        const devMsg = `🚨 *CRITICAL DLE KANBAN ERROR!* 🚨\n📍 *Instance:* ${instance}\n📦 *Заказ №:* ${orderId}\n⚠️ *Қате:* ${error?.message || error}\n🛠 *Орны:* kanbanController.js\n\nЧек немесе статус клиентке бармай қалды!`;
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
function emitPrintNewOrder(req, orderData) {
    const io = req.app.get("io");
    if (!io) {
        console.error("[SOCKET] Error: Socket.io (io) not found.");
        return false;
    }
    io.emit("print_new_order", orderData);
    console.log(`[SOCKET] Print signal sent. Order: #${orderData.order_id || orderData.id || "-"}`);
    return true;
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
            const body = req.body || {};
            const instanceId = getInstanceId(body);
            const action = String(body.action || body.event || "").trim();
            const phone = getPhone(body);
            const kanbanStatus = String(body?.status || body?.new_status || body?.order_status || "").trim();
            if (!instanceId)
                return res.status(400).json({ ok: false, error: "instance is required" });
            if (kanbanStatus === "paid") {
                emitPrintNewOrder(req, body);
            }
            if (action === "shift_note_created") {
                await saveShiftNote(instanceId, body.id || body.note_id || body.key, body.text || body.note, body.expires_at || body.expiresAt);
                return res.json({ ok: true, action, saved: true });
            }
            if (action === "shift_note_deleted") {
                await deleteShiftNote(instanceId, body.id || body.note_id || body.key, body.text || body.note || "");
                return res.json({ ok: true, action, deleted: true });
            }
            if (action === "request_payment" && phone) {
                const config = await getRestaurantConfig(instanceId);
                const runtime = config?.domain ? await getRuntimeStatus(instanceId, config.domain, { forceFresh: true }) : null;
                const runtimeDetails = Array.isArray(runtime?.payment_details) ? runtime.payment_details : [];
                const fallback = !runtimeDetails.length && config?.kaspi_info
                    ? [{ label: "Kaspi", value: config.kaspi_info, source: "nocodb_fallback" }]
                    : [];
                const text = paymentDetailsText(runtimeDetails.length ? runtimeDetails : fallback);
                if (text) {
                    await sendWhatsProMessage({
                        instanceId,
                        phone,
                        text: `Төлем реквизиттері:\n${text}\n\nТөлеген соң чекті осы чатқа жіберіңіз.`,
                    });
                }
                return res.json({ ok: true, action, sent: Boolean(text) });
            }
            if (body.text || body.message) {
                if (!phone)
                    return res.status(400).json({ ok: false, error: "phone is required" });
                const send = await sendWhatsProMessage({
                    instanceId,
                    phone,
                    text: String(body.text || body.message),
                });
                return res.json({ ok: true, action: action || "send_message", send });
            }
            const io = req.app.get("io");
            if (io && (action === "new_order" || action === "print_order" || body.print)) {
                emitPrintNewOrder(req, body);
            }
            return res.json({ ok: true, action: action || "noop" });
        }
        catch (error) {
            await notifyKanbanDeveloperSiren(req, error);
            await notifyDeveloperSystemFailure(getInstanceId(req.body || {}), error, {
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
                emitPrintNewOrder(req, orderData);
                res.status(200).send({ success: true, message: "Print signal sent to agent" });
            }
            else {
                console.error("[SOCKET] Error: Socket.io (io) not found.");
                res.status(500).send({ success: false, error: "Socket server error" });
            }
        }
        catch (error) {
            void notifyDeveloperSystemFailure(getInstanceId(req.body || {}), error, {
                scope: "print_trigger",
            }).catch(() => undefined);
            if (!res.headersSent) {
                res.status(500).send({ success: false, error: error?.message || "print trigger failed" });
            }
        }
    });
    return router;
}

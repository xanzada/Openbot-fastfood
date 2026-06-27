import type { Router } from "express";
import { Router as createRouter } from "express";
import { getRuntimeStatus, normalizePhone } from "../services/dle.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { deleteShiftNote, saveShiftNote } from "../services/redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { getConfigSummary, runDependencyChecks } from "../services/diagnostics.service.js";

function verifySecret(req: any, res: any, next: any) {
  const expected = process.env.OPENBOT_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN;
  if (!expected) return next();
  const got =
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    req.headers["x-api-key"] ||
    req.body?.token ||
    req.query?.token;
  if (got !== expected) return res.status(401).json({ ok: false, error: "unauthorized" });
  return next();
}

function getInstanceId(body: Record<string, any>) {
  return String(body.instanceId || body.instance || body.restaurant_id || "").trim();
}

function getPhone(body: Record<string, any>) {
  return normalizePhone(body.phone || body.senderPhone || body.normalizedPhone || "");
}

function paymentDetailsText(details: any[]) {
  if (!details.length) return "";
  return details
    .map((item) => `${String(item.label || "Реквизит").trim()}: ${String(item.value || "").trim()}`)
    .filter(Boolean)
    .join("\n");
}

export function systemRoute(): Router {
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

  router.post("/kanban-webhook", verifySecret, async (req, res) => {
    try {
      const body = req.body || {};
      const instanceId = getInstanceId(body);
      const action = String(body.action || body.event || "").trim();
      const phone = getPhone(body);

      if (!instanceId) return res.status(400).json({ ok: false, error: "instance is required" });

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
        if (!phone) return res.status(400).json({ ok: false, error: "phone is required" });
        const send = await sendWhatsProMessage({
          instanceId,
          phone,
          text: String(body.text || body.message),
        });
        return res.json({ ok: true, action: action || "send_message", send });
      }

      const io = req.app.get("io");
      if (io && (action === "new_order" || action === "print_order" || body.print)) {
        io.emit("print_new_order", body);
      }

      return res.json({ ok: true, action: action || "noop" });
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: error?.message || "kanban webhook failed" });
      }
    }
  });

  router.post("/api/print_trigger", verifySecret, (req, res) => {
    try {
      const io = req.app.get("io");
      if (io) io.emit("print_new_order", req.body || {});
      res.json({ ok: true, emitted: Boolean(io) });
    } catch (error: any) {
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: error?.message || "print trigger failed" });
      }
    }
  });

  return router;
}

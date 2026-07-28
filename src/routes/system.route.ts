import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { getConfigSummary, runDependencyChecks } from "../services/diagnostics.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { getRestaurantConfig } from "../services/platformConfig.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import { clearUserLang, getActiveShiftNotes, getUserLangState } from "../services/redis.service.js";

function getRequestInstanceId(req: Request) {
  return String(req.body?.instance || "").trim();
}

function getBearerToken(req: Request) {
  const authorization = req.headers.authorization || "";
  return authorization.replace(/^Bearer\s+/i, "");
}

function envBool(name: string, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function isLegacyDleAction(value: unknown) {
  return new Set([
    "new_order",
    "status_changed",
    "request_payment",
    "order_rejected",
    "shift_note_created",
    "shift_note_deleted",
    "create_order",
    "order_created",
    "update_status",
    "change_status",
    "status_update",
    "payment_request",
    "request_pay",
    "reject_order",
    "rejected_order",
    "cancel_order",
    "create_shift_note",
    "delete_shift_note",
  ]).has(String(value || "").trim());
}

function verifySecret(channel = "webhook") {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (channel === "kanban" && !envBool("DLE_WEBHOOK_AUTH_REQUIRED", false) && isLegacyDleAction(req.body?.action || req.body?.ajax_action)) {
      return next();
    }

    const expected = process.env.OPENBOT_WEBHOOK_SECRET;
    const got = getBearerToken(req) || req.headers["x-api-key"] || req.body?.token || req.body?.secret_token || req.query?.token || req.query?.secret_token;

    if (expected && safeCompare(got, expected)) {
      return next();
    }

    try {
      const instanceId = getRequestInstanceId(req);
      if (!instanceId) {
        return res.status(401).json({ ok: false, error: "unauthorized" });
      }

      const config = await getRestaurantConfig(instanceId);
      assertTenantSecret(req, config, channel);
      return next();
    } catch (error: any) {
      return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
    }
  };
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

  // Read or reset what the bot believes about one guest. "webhook" channel, so
  // it never takes the legacy no-auth path the kanban webhook still allows.
  router.post("/api/maintenance/language", verifySecret("webhook"), async (req, res) => {
    const instance = String(req.body?.instance || "").trim();
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const action = String(req.body?.action || "get").trim().toLowerCase();
    if (!instance || !phone) {
      res.status(400).json({ ok: false, error: "INSTANCE_AND_PHONE_REQUIRED" });
      return;
    }
    if (action !== "get" && action !== "clear") {
      res.status(400).json({ ok: false, error: "ACTION_MUST_BE_GET_OR_CLEAR" });
      return;
    }
    try {
      const before = await getUserLangState(instance, phone);
      if (action === "get") {
        res.json({ ok: true, instance, phone, ...before });
        return;
      }
      const removed = await clearUserLang(instance, phone);
      console.info(`[OPENBOT:MAINTENANCE] language lock cleared instance=${instance} keys=${removed} was=${before.language || "-"}`);
      res.json({ ok: true, instance, phone, cleared: removed, was: before.language, wasSiteHint: before.siteHint });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || "language maintenance failed" });
    }
  });

  // What the agent is actually being told about the shift right now.
  router.post("/api/maintenance/notes", verifySecret("webhook"), async (req, res) => {
    const instance = String(req.body?.instance || "").trim();
    if (!instance) {
      res.status(400).json({ ok: false, error: "INSTANCE_REQUIRED" });
      return;
    }
    try {
      const notes = await getActiveShiftNotes(instance);
      res.json({ ok: true, instance, count: notes.length, notes });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || "notes read failed" });
    }
  });

  router.post("/api/print_trigger", verifySecret("kanban"), async (req, res) => {
    try {
      const io = req.app.get("io");
      const orderData = req.body || {};

      if (!io) {
        res.status(500).json({ success: false, error: "Socket server error" });
        return;
      }

      io.emit("print_new_order", orderData);
      console.info(`[SOCKET] Print signal sent. Order: #${orderData.order_id || orderData.id || "-"}`);
      res.status(200).json({ success: true, message: "Print signal sent to agent" });
    } catch (error: any) {
      const instanceId = getRequestInstanceId(req);
      await notifyDeveloperSystemFailure(instanceId, error, {
        scope: "print_trigger",
        orderId: req.body?.order_id || req.body?.id || "",
      }).catch(() => undefined);

      if (!res.headersSent) {
        res.status(500).json({ success: false, error: error?.message || "print trigger failed" });
      }
    }
  });

  return router;
}

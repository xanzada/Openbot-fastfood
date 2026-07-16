import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { handleKanbanWebhook } from "../controllers/kanban.js";
import { normalizeDlePayload } from "./dleWebhook.route.js";
import { getConfigSummary, runDependencyChecks } from "../services/diagnostics.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";

function getRequestInstanceId(req: Request) {
  return String(
      req.body?.instanceId ||
      req.body?.instance ||
      req.body?.restaurant_id ||
      req.body?.restaurant_instance ||
      req.body?.restaurantInstance ||
      req.query?.instanceId ||
      req.query?.instance ||
      req.query?.restaurant_id ||
      req.query?.restaurant_instance ||
      ""
  ).trim();
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
    "payment_request",
    "reject_order",
    "rejected_order",
    "create_shift_note",
    "delete_shift_note",
  ]).has(String(value || "").trim());
}

function verifySecret(channel = "webhook") {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (channel === "kanban" && !envBool("DLE_WEBHOOK_AUTH_REQUIRED", false) && isLegacyDleAction(req.body?.action || req.body?.ajax_action)) {
      return next();
    }

    const expected = process.env.OPENBOT_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN;
    const got = getBearerToken(req) || req.headers["x-api-key"] || req.body?.token || req.query?.token;

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

  router.post("/kanban-webhook", verifySecret("kanban"), async (req, res) => {
    try {
      normalizeDlePayload(req);
      await handleKanbanWebhook(req, res);
    } catch (error: any) {
      const instanceId = getRequestInstanceId(req);
      await notifyDeveloperSystemFailure(instanceId, error, {
        scope: "kanban-webhook",
        orderId: req.body?.order_id || req.body?.order?.id || req.body?.id || "",
      }).catch(() => undefined);

      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: error?.message || "kanban webhook failed" });
      }
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

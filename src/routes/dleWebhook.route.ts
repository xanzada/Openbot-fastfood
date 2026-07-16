import type { NextFunction, Request, Response, Router } from "express";
import { Router as createRouter } from "express";
import { handleKanbanWebhook } from "../controllers/kanban.js";
import { getRestaurantConfig } from "../services/nocodb.service.js";
import { assertTenantSecret, safeCompare } from "../services/tenantAuth.service.js";
import { notifyDeveloperSystemFailure } from "../services/developerNotify.service.js";

const DLE_WEBHOOK_PATHS = [
  "/dle-webhook",
  "/website-webhook",
  "/api/dle-webhook",
  "/api/website-webhook",
  "/api/kanban-webhook",
  "/webhook/dle",
  "/webhook/kanban",
  "/webhook/website",
];

function envBool(name: string, fallback = false) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value);
}

function getRequestInstanceId(req: Request) {
  return String(
    req.body?.instance ||
      req.body?.instanceId ||
      req.body?.restaurant_id ||
      req.query?.instance ||
      req.query?.instanceId ||
      req.query?.restaurant_id ||
      ""
  ).trim();
}

function getBearerToken(req: Request) {
  return String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

async function verifyDleWebhook(req: Request, res: Response, next: NextFunction) {
  if (!envBool("DLE_WEBHOOK_AUTH_REQUIRED", false)) return next();

  const expected = process.env.DLE_WEBHOOK_SECRET || process.env.CRM_SECRET_TOKEN || process.env.OPENBOT_WEBHOOK_SECRET;
  const got = getBearerToken(req) || req.headers["x-api-key"] || req.body?.token || req.query?.token;
  if (expected && safeCompare(got, expected)) return next();

  try {
    const instanceId = getRequestInstanceId(req);
    if (!instanceId) return res.status(401).json({ ok: false, error: "unauthorized" });
    const config = await getRestaurantConfig(instanceId);
    assertTenantSecret(req, config, "kanban");
    return next();
  } catch (error: any) {
    return res.status(error?.statusCode || 401).json({ ok: false, error: error?.message || "unauthorized" });
  }
}

async function handleDleWebhook(req: Request, res: Response) {
  try {
    await handleKanbanWebhook(req, res);
  } catch (error: any) {
    const instanceId = getRequestInstanceId(req);
    await notifyDeveloperSystemFailure(instanceId, error, {
      scope: "dle-website-webhook",
      action: req.body?.action || "",
      orderId: req.body?.order_id || req.body?.orderId || req.body?.id || "",
    }).catch(() => undefined);

    if (!res.headersSent) {
      res.status(500).json({ success: false, error: error?.message || "dle webhook failed" });
    }
  }
}

export function dleWebhookRoute(): Router {
  const router = createRouter();

  for (const path of DLE_WEBHOOK_PATHS) {
    router.post(path, verifyDleWebhook, handleDleWebhook);
  }

  return router;
}

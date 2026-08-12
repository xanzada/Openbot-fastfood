// Deployed by Dokploy from codex/fix-wa-payment-signal. Only package*.json,
// tsconfig.json and src/ enter the image (see Dockerfile) — a change anywhere
// else in this repo will never reach the container, however green the deploy is.
import "dotenv/config";
import http from "node:http";
import express from "express";
import { Server } from "socket.io";
import { dleWebhookRoute } from "./routes/dleWebhook.route.js";
import { whatsappWebhookRoute } from "./routes/whatsappWebhook.route.js";
import { systemRoute } from "./routes/system.route.js";
import { connectRedis } from "./services/redis.service.js";
import { logStartupDiagnostics } from "./services/diagnostics.service.js";
import { startDailyCron } from "./cron/statsCron.js";
import { startRuntimeWatcher } from "./cron/runtimeWatch.js";
import { notifyAllDevelopersSystemFailure, notifyDeveloperSystemFailure } from "./services/developerNotify.service.js";
import { startWhatsProOutboxWorker } from "./transport/whatspro.client.js";
import { safeCompare } from "./services/tenantAuth.service.js";
import { envNumber } from "./utils/envNumber.js";

const app = express();
const port = envNumber(process.env.PORT, 4100, { min: 1 });
const httpServer = http.createServer(app);
const socketAllowedOrigins = String(process.env.SOCKET_ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const io = new Server(httpServer, {
  cors: { origin: socketAllowedOrigins.length ? socketAllowedOrigins : false },
});

io.use((socket, next) => {
  const expected = String(process.env.SOCKET_API_TOKEN || "");
  const supplied = socket.handshake.auth?.token || socket.handshake.headers["x-api-key"];
  const instanceId = String(socket.handshake.auth?.instance || "").trim();
  if (!expected || !instanceId || !safeCompare(supplied, expected)) {
    next(new Error("unauthorized"));
    return;
  }
  socket.data.instanceId = instanceId;
  void socket.join(instanceId);
  next();
});

function reportGlobalFailure(scope: string, error: unknown, meta: Record<string, unknown> = {}) {
  console.error(`[OPENBOT:${scope.toUpperCase()}:FAIL]`, error instanceof Error ? error.stack || error.message : error);
  void notifyAllDevelopersSystemFailure(error, { scope, ...meta }).catch(() => undefined);
}

process.on("unhandledRejection", (reason) => {
  reportGlobalFailure("unhandled_rejection", reason);
});

process.on("uncaughtException", (error, origin) => {
  reportGlobalFailure("uncaught_exception", error, { status: origin });
  setTimeout(() => process.exit(1), 1500).unref();
});

function normalizeMountPath(value: unknown, fallback: string) {
  const raw = String(value || fallback).trim() || fallback;
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

const whatsproWebhookPath = normalizeMountPath(process.env.WHATSPRO_WEBHOOK_PATH, "/whatspro-webhook");
const dleWebhookPath = normalizeMountPath(process.env.DLE_WEBHOOK_PATH, "/kanban-webhook");

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.set("io", io);

app.use(whatsproWebhookPath, whatsappWebhookRoute());
app.use(dleWebhookPath, dleWebhookRoute());
app.use(systemRoute());

app.use((error: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const instanceId = String(req.body?.instance || req.body?.instance_id || req.body?.instanceId || "").trim();
  const meta = { scope: "express_request", status: req.method, action: req.path };
  if (instanceId) {
    void notifyDeveloperSystemFailure(instanceId, error, meta).catch(() => undefined);
  } else {
    void notifyAllDevelopersSystemFailure(error, meta).catch(() => undefined);
  }
  if (!res.headersSent) res.status(500).json({ ok: false, error: "internal_error" });
});

io.on("connection", (socket) => {
  console.log(`[OPENBOT] printer/socket connected: ${socket.id} instance=${socket.data.instanceId}`);
});

await connectRedis().catch((error) => {
  console.warn("[OPENBOT:BOOT:WARN] Redis unavailable at startup:", error?.message || error);
});
startDailyCron();
startWhatsProOutboxWorker();
startRuntimeWatcher();

httpServer.listen(port, () => {
  console.log(`[OPENBOT] VoltAgent FastFood agent listening on ${port}`);
  console.log(`[OPENBOT] WhatsPro webhook mounted at ${whatsproWebhookPath}`);
  console.log(`[OPENBOT] DLE webhook mounted at ${dleWebhookPath}`);
  void logStartupDiagnostics()
    .then((checks) => Promise.all(
      checks
        .filter((check) => !check.ok)
        .map((check) => notifyAllDevelopersSystemFailure(new Error(check.message || `${check.name} unavailable`), {
          scope: "startup_dependency",
          dependency: check.name,
          status: check.status || "FAIL",
        }))
    ))
    .catch((error) => reportGlobalFailure("startup_diagnostics", error));
});

httpServer.on("error", (error) => reportGlobalFailure("http_server", error));

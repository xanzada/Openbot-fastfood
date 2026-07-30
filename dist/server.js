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
import { notifyAllDevelopersSystemFailure, notifyDeveloperSystemFailure } from "./services/developerNotify.service.js";
import { startWhatsProOutboxWorker } from "./transport/whatspro.client.js";
const app = express();
const port = Number(process.env.PORT || 4100);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" },
});
function reportGlobalFailure(scope, error, meta = {}) {
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
function normalizeMountPath(value, fallback) {
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
app.use((error, req, res, _next) => {
    const instanceId = String(req.body?.instance || req.body?.instance_id || req.body?.instanceId || "").trim();
    const meta = { scope: "express_request", status: req.method, action: req.path };
    if (instanceId) {
        void notifyDeveloperSystemFailure(instanceId, error, meta).catch(() => undefined);
    }
    else {
        void notifyAllDevelopersSystemFailure(error, meta).catch(() => undefined);
    }
    if (!res.headersSent)
        res.status(500).json({ ok: false, error: "internal_error" });
});
io.on("connection", (socket) => {
    console.log(`[OPENBOT] printer/socket connected: ${socket.id}`);
});
await connectRedis().catch((error) => {
    console.warn("[OPENBOT:BOOT:WARN] Redis unavailable at startup:", error?.message || error);
});
startDailyCron();
startWhatsProOutboxWorker();
httpServer.listen(port, () => {
    console.log(`[OPENBOT] VoltAgent FastFood agent listening on ${port}`);
    console.log(`[OPENBOT] WhatsPro webhook mounted at ${whatsproWebhookPath}`);
    console.log(`[OPENBOT] DLE webhook mounted at ${dleWebhookPath}`);
    void logStartupDiagnostics()
        .then((checks) => Promise.all(checks
        .filter((check) => !check.ok)
        .map((check) => notifyAllDevelopersSystemFailure(new Error(check.message || `${check.name} unavailable`), {
        scope: "startup_dependency",
        dependency: check.name,
        status: check.status || "FAIL",
    }))))
        .catch((error) => reportGlobalFailure("startup_diagnostics", error));
});
httpServer.on("error", (error) => reportGlobalFailure("http_server", error));

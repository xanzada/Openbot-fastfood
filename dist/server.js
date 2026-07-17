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
const app = express();
const port = Number(process.env.PORT || 4100);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
    cors: { origin: "*" },
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
io.on("connection", (socket) => {
    console.log(`[OPENBOT] printer/socket connected: ${socket.id}`);
});
await connectRedis().catch((error) => {
    console.warn("[OPENBOT:BOOT:WARN] Redis unavailable at startup:", error?.message || error);
});
startDailyCron();
httpServer.listen(port, () => {
    console.log(`[OPENBOT] VoltAgent FastFood agent listening on ${port}`);
    console.log(`[OPENBOT] WhatsPro webhook mounted at ${whatsproWebhookPath}`);
    console.log(`[OPENBOT] DLE webhook mounted at ${dleWebhookPath}`);
    void logStartupDiagnostics().catch((error) => {
        console.error("[OPENBOT:BOOT:FAIL] startup diagnostics crashed:", error?.message || error);
    });
});

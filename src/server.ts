import "dotenv/config";
import http from "node:http";
import express from "express";
import { Server } from "socket.io";
import { whatsappWebhookRoute } from "./routes/whatsappWebhook.route.js";
import { systemRoute } from "./routes/system.route.js";
import { connectRedis } from "./services/redis.service.js";

const app = express();
const port = Number(process.env.PORT || 4100);
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));
app.set("io", io);

app.use(whatsappWebhookRoute());
app.use(systemRoute());

io.on("connection", (socket) => {
  console.log(`[OPENBOT] printer/socket connected: ${socket.id}`);
});

await connectRedis().catch((error) => {
  console.warn("[OPENBOT] Redis unavailable at startup:", error?.message || error);
});

httpServer.listen(port, () => {
  console.log(`[OPENBOT] VoltAgent FastFood agent listening on ${port}`);
});

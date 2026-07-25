import crypto from "node:crypto";
import { getAllRestaurantConfigs, getRestaurantConfig } from "./nocodb.service.js";
import { redisClient } from "./redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
const ALERT_DEDUPE_SECONDS = Math.max(10, Number(process.env.OPENBOT_DEV_ALERT_DEDUPE_SECONDS || 60));
const localDedupe = /* @__PURE__ */ new Map();
function normalizePhone(value = "") {
  return String(value || "").replace(/\D/g, "");
}
function cleanAlertText(value, max = 600) {
  const text = String(value ?? "unknown_error").replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]").replace(/([?&](?:token|secret|key|api_key)=)[^&\s]+/gi, "$1[REDACTED]").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return (text || "unknown_error").slice(0, max);
}
function errorMessage(error) {
  return cleanAlertText(error instanceof Error ? error.message : error);
}
function errorCode(error) {
  const value = error && typeof error === "object" ? error.code || error.name : "";
  return cleanAlertText(value || "ERROR", 80);
}
function alertFingerprint(instanceId, error, meta) {
  return crypto.createHash("sha256").update(`${instanceId}|${String(meta.scope || "unknown")}|${errorCode(error)}|${errorMessage(error)}`).digest("hex").slice(0, 20);
}
async function claimAlert(fingerprint) {
  const now = Date.now();
  for (const [key, expiresAt] of localDedupe) {
    if (expiresAt <= now) localDedupe.delete(key);
  }
  if ((localDedupe.get(fingerprint) || 0) > now) return false;
  localDedupe.set(fingerprint, now + ALERT_DEDUPE_SECONDS * 1e3);
  if (!redisClient.isOpen) return true;
  try {
    const result = await redisClient.set(`dev_alert:${fingerprint}`, "1", {
      NX: true,
      EX: ALERT_DEDUPE_SECONDS
    });
    return result === "OK";
  } catch {
    return true;
  }
}
function metaLines(meta) {
  const allowed = [
    ["Action", "action"],
    ["Order", "orderId"],
    ["Message ID", "messageId"],
    ["Customer", "customerPhone"],
    ["Dependency", "dependency"],
    ["Status", "status"]
  ];
  return allowed.map(([label, key]) => meta[key] === void 0 || meta[key] === "" ? "" : `${label}: ${cleanAlertText(meta[key], 160)}`).filter(Boolean);
}
async function persistDeveloperAlertOutbox(instanceId, incidentId, text, sendError) {
  if (!redisClient.isOpen) return false;
  try {
    const payload = JSON.stringify({ instanceId, incidentId, text, error: errorMessage(sendError), failedAt: Date.now(), channel: "whatspro" });
    await redisClient.multi().setEx(`dev_alert_outbox:${instanceId}:${incidentId}`, 7 * 24 * 60 * 60, payload).zAdd(`dev_alert_outbox:${instanceId}`, [{ score: Date.now(), value: incidentId }]).expire(`dev_alert_outbox:${instanceId}`, 7 * 24 * 60 * 60).exec();
    return true;
  } catch {
    return false;
  }
}
async function sendAlertWithConfig(instanceId, config, error, meta) {
  const developerPhone = normalizePhone(config.dev_phone);
  if (!developerPhone) {
    console.error(`[OPENBOT:DEV-ALERT:SKIP] instance=${instanceId} reason=dev_phone_missing`);
    return false;
  }
  const fingerprint = alertFingerprint(instanceId, error, meta);
  if (!await claimAlert(fingerprint)) return false;
  const incidentId = `${(/* @__PURE__ */ new Date()).toISOString().replace(/\D/g, "").slice(0, 14)}-${fingerprint.slice(0, 6)}`;
  const alertText = [
    "\u26A0\uFE0F OPENBOT \u0410\u049A\u0410\u0423\u042B",
    `Instance: ${instanceId}`,
    `\u0411\u04E9\u043B\u0456\u043C: ${cleanAlertText(meta.scope || "unknown", 120)}`,
    `\u049A\u0430\u0442\u0435: ${errorCode(error)} \u2014 ${errorMessage(error)}`,
    ...metaLines(meta),
    `\u0423\u0430\u049B\u044B\u0442: ${(/* @__PURE__ */ new Date()).toISOString()}`,
    `Incident: ${incidentId}`,
    "\u049A\u0430\u043B\u043F\u044B\u043D\u0430 \u043A\u0435\u043B\u0442\u0456\u0440\u0443 \u0441\u0430\u044F\u0441\u0430\u0442\u044B: \u049B\u0430\u0443\u0456\u043F\u0442\u0456 process \u049B\u0430\u0442\u0435\u0441\u0456\u043D\u0434\u0435 \u043A\u043E\u043D\u0442\u0435\u0439\u043D\u0435\u0440 controlled exit \u0436\u0430\u0441\u0430\u043F, Docker \u0430\u0440\u049B\u044B\u043B\u044B \u049B\u0430\u0439\u0442\u0430 \u0456\u0441\u043A\u0435 \u049B\u043E\u0441\u044B\u043B\u0430\u0434\u044B."
  ].join("\n");
  try {
    const result = await sendWhatsProMessage({ instanceId, phone: developerPhone, text: alertText });
    if (result?.acknowledged !== true) throw new Error(result?.reason || "DEVELOPER_ALERT_NOT_ACKNOWLEDGED");
    return true;
  } catch (sendError) {
    await persistDeveloperAlertOutbox(instanceId, incidentId, alertText, sendError);
    console.error(`[OPENBOT:DEV-ALERT:FAIL] instance=${instanceId} incident=${incidentId}:`, errorMessage(sendError));
    return false;
  }
}
async function notifyDeveloperSystemFailure(instanceId, error, meta = {}) {
  const safeInstanceId = String(instanceId || "").trim();
  if (!safeInstanceId) return false;
  try {
    const config = await getRestaurantConfig(safeInstanceId).catch(() => null) || {};
    return await sendAlertWithConfig(safeInstanceId, config, error, meta);
  } catch (notifyError) {
    console.error(`[OPENBOT:DEV-ALERT:CRASH] instance=${safeInstanceId}:`, errorMessage(notifyError));
    return false;
  }
}
async function notifyAllDevelopersSystemFailure(error, meta = {}) {
  try {
    const configs = await getAllRestaurantConfigs().catch(() => []);
    const unique = /* @__PURE__ */ new Map();
    for (const config of configs) {
      const instanceId = String(config?.instance_id || config?.instance || "").trim();
      if (instanceId && normalizePhone(config?.dev_phone)) unique.set(instanceId, config);
    }
    const results = await Promise.allSettled(
      [...unique.entries()].map(([instanceId, config]) => sendAlertWithConfig(instanceId, config, error, meta))
    );
    return results.filter((result) => result.status === "fulfilled" && result.value).length;
  } catch (notifyError) {
    console.error("[OPENBOT:DEV-ALERT:GLOBAL:CRASH]", errorMessage(notifyError));
    return 0;
  }
}
export {
  notifyAllDevelopersSystemFailure,
  notifyDeveloperSystemFailure
};

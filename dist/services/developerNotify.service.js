import crypto from "node:crypto";
import { getAllRestaurantConfigs, getRestaurantConfig } from "./platformConfig.service.js";
import { redisClient } from "./redis.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
import { envNumber } from "../utils/envNumber.js";
const ALERT_DEDUPE_SECONDS = envNumber(process.env.OPENBOT_DEV_ALERT_DEDUPE_SECONDS, 60, { min: 10 });
const localDedupe = new Map();
function normalizePhone(value = "") {
    return String(value || "").replace(/\D/g, "");
}
function cleanAlertText(value, max = 600) {
    const text = String(value ?? "unknown_error")
        .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
        .replace(/([?&](?:token|secret|key|api_key)=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/[\r\n\t]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
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
    return crypto
        .createHash("sha256")
        .update(`${instanceId}|${String(meta.scope || "unknown")}|${errorCode(error)}|${errorMessage(error)}`)
        .digest("hex")
        .slice(0, 20);
}
async function claimAlert(fingerprint) {
    const now = Date.now();
    for (const [key, expiresAt] of localDedupe) {
        if (expiresAt <= now)
            localDedupe.delete(key);
    }
    if ((localDedupe.get(fingerprint) || 0) > now)
        return false;
    localDedupe.set(fingerprint, now + ALERT_DEDUPE_SECONDS * 1000);
    if (!redisClient.isOpen)
        return true;
    try {
        const result = await redisClient.set(`dev_alert:${fingerprint}`, "1", {
            NX: true,
            EX: ALERT_DEDUPE_SECONDS,
        });
        return result === "OK";
    }
    catch {
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
        ["Status", "status"],
    ];
    return allowed
        .map(([label, key]) => (meta[key] === undefined || meta[key] === "" ? "" : `${label}: ${cleanAlertText(meta[key], 160)}`))
        .filter(Boolean);
}
async function persistDeveloperAlertOutbox(instanceId, incidentId, text, sendError) {
    if (!redisClient.isOpen)
        return false;
    try {
        const payload = JSON.stringify({ instanceId, incidentId, text, error: errorMessage(sendError), failedAt: Date.now(), channel: "whatspro" });
        await redisClient.multi()
            .setEx(`dev_alert_outbox:${instanceId}:${incidentId}`, 7 * 24 * 60 * 60, payload)
            .zAdd(`dev_alert_outbox:${instanceId}`, [{ score: Date.now(), value: incidentId }])
            .expire(`dev_alert_outbox:${instanceId}`, 7 * 24 * 60 * 60)
            .exec();
        return true;
    }
    catch {
        return false;
    }
}
async function sendAlertWithConfig(instanceId, config, error, meta) {
    const developerPhone = normalizePhone(config.dev_phone || process.env.OPENBOT_DEVELOPER_PHONE);
    if (!developerPhone) {
        console.error(`[OPENBOT:DEV-ALERT:SKIP] instance=${instanceId} reason=dev_phone_missing`);
        return false;
    }
    const fingerprint = alertFingerprint(instanceId, error, meta);
    if (!(await claimAlert(fingerprint)))
        return false;
    const incidentId = `${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${fingerprint.slice(0, 6)}`;
    const alertText = [
        "⚠️ OPENBOT АҚАУЫ",
        `Instance: ${instanceId}`,
        `Бөлім: ${cleanAlertText(meta.scope || "unknown", 120)}`,
        `Қате: ${errorCode(error)} — ${errorMessage(error)}`,
        ...metaLines(meta),
        `Уақыт: ${new Date().toISOString()}`,
        `Incident: ${incidentId}`,
        "Қалпына келтіру саясаты: қауіпті process қатесінде контейнер controlled exit жасап, Docker арқылы қайта іске қосылады.",
    ].join("\n");
    try {
        const result = await sendWhatsProMessage({ instanceId, phone: developerPhone, text: alertText });
        if (result?.acknowledged !== true)
            throw new Error(result?.reason || "DEVELOPER_ALERT_NOT_ACKNOWLEDGED");
        return true;
    }
    catch (sendError) {
        await persistDeveloperAlertOutbox(instanceId, incidentId, alertText, sendError);
        console.error(`[OPENBOT:DEV-ALERT:FAIL] instance=${instanceId} incident=${incidentId}:`, errorMessage(sendError));
        return false;
    }
}
export async function notifyDeveloperSystemFailure(instanceId, error, meta = {}) {
    const safeInstanceId = String(instanceId || "").trim();
    if (!safeInstanceId)
        return false;
    try {
        const config = (await getRestaurantConfig(safeInstanceId).catch(() => null)) || {};
        return await sendAlertWithConfig(safeInstanceId, config, error, meta);
    }
    catch (notifyError) {
        console.error(`[OPENBOT:DEV-ALERT:CRASH] instance=${safeInstanceId}:`, errorMessage(notifyError));
        return false;
    }
}
export async function notifyAllDevelopersSystemFailure(error, meta = {}) {
    try {
        const configs = await getAllRestaurantConfigs().catch(() => []);
        const unique = new Map();
        for (const config of configs) {
            const instanceId = String(config?.instance_id || config?.instance || "").trim();
            if (instanceId && normalizePhone(config?.dev_phone || process.env.OPENBOT_DEVELOPER_PHONE))
                unique.set(instanceId, config);
        }
        const results = await Promise.allSettled([...unique.entries()].map(([instanceId, config]) => sendAlertWithConfig(instanceId, config, error, meta)));
        return results.filter((result) => result.status === "fulfilled" && result.value).length;
    }
    catch (notifyError) {
        console.error("[OPENBOT:DEV-ALERT:GLOBAL:CRASH]", errorMessage(notifyError));
        return 0;
    }
}

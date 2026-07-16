import { getRestaurantConfig } from "./nocodb.service.js";
import { sendWhatsProMessage } from "../transport/whatspro.client.js";
function normalizePhone(value = "") {
    return String(value || "").replace(/\D/g, "");
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error || "unknown_error");
}
export async function notifyDeveloperSystemFailure(instanceId, error, meta = {}) {
    const safeInstanceId = String(instanceId || "").trim();
    if (!safeInstanceId)
        return false;
    const config = (await getRestaurantConfig(safeInstanceId).catch(() => null)) || {};
    const developerPhone = normalizePhone(config.dev_phone);
    if (!developerPhone)
        return false;
    await sendWhatsProMessage({
        instanceId: safeInstanceId,
        phone: developerPhone,
        text: [
            "OPENBOT SYSTEM FAILURE",
            `Instance: ${safeInstanceId}`,
            `Scope: ${String(meta.scope || "unknown")}`,
            `Error: ${errorMessage(error)}`,
            meta.messageId ? `Message ID: ${String(meta.messageId)}` : "",
            meta.customerPhone ? `Customer: ${String(meta.customerPhone)}` : "",
        ]
            .filter(Boolean)
            .join("\n"),
    });
    return true;
}

import { auditError, auditOutbound } from "./auditLogger.service.js";
import { uploadOrderDocument } from "./alemiApi.service.js";
import { MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES } from "./inboundGuard.service.js";
function failure(errorCode, safeMessage) {
    return { success: false, errorCode, safeMessage };
}
export async function deliverReceiptToClient(input, sendReceipt = uploadOrderDocument) {
    const orderNumber = String(input.orderNumber || "").trim();
    const phone = String(input.phone || "").replace(/\D/g, "");
    if (!orderNumber || !phone)
        return failure("invalid_recipient", "receipt_delivery_target_invalid");
    const mimeType = String(input.mimeType || "").split(";", 1)[0].trim().toLowerCase();
    const allowedMimeTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"]);
    if (!allowedMimeTypes.has(mimeType))
        return failure("invalid_receipt_media", "receipt_media_type_invalid");
    const encoded = String(input.receiptBase64 || "").replace(/\s+/g, "");
    if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
        return failure("invalid_receipt_media", "receipt_media_invalid");
    }
    const bytes = Buffer.from(encoded, "base64");
    const maxBytes = mimeType === "application/pdf" ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;
    if (!bytes.byteLength || bytes.byteLength > maxBytes) {
        return failure(bytes.byteLength ? "receipt_too_large" : "invalid_receipt_media", bytes.byteLength ? "receipt_media_too_large" : "receipt_media_invalid");
    }
    let response;
    try {
        response = await sendReceipt({
            instanceId: input.instanceId,
            orderId: orderNumber,
            sourceMessageId: String(input.sourceMessageId || "").trim(),
            bytes,
            mimeType,
            documentKind: "receipt",
        }, { config: input.config });
    }
    catch (error) {
        auditError("Receipt upload to Alemi failed", error, {
            instanceId: input.instanceId,
            orderNumber,
            sourceMessageId: input.sourceMessageId,
        });
        return failure("delivery_failed", "receipt_delivery_failed");
    }
    const deliveredOrderNumber = String(response?.order_id || orderNumber).trim();
    if (deliveredOrderNumber !== orderNumber) {
        auditError("Receipt upload was not confirmed by Alemi", new Error("RECEIPT_DELIVERY_UNCONFIRMED"), {
            instanceId: input.instanceId,
            orderNumber,
            deliveredOrderNumber,
        });
        return failure("delivery_unconfirmed", "receipt_delivery_unconfirmed");
    }
    const deliveredAt = String(response?.attached_at || response?.uploaded_at || response?.created_at || new Date().toISOString());
    const deliveryId = String(response?.document_id || response?.delivery_id || `receipt:${orderNumber}:${input.sourceMessageId}`);
    auditOutbound("Receipt upload to Alemi confirmed", {
        instanceId: input.instanceId,
        orderNumber,
        deliveryId,
        deliveredAt,
    });
    return { success: true, deliveryId, deliveredAt };
}

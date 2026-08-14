import { auditError, auditOutbound } from "./auditLogger.service.js";
import { uploadOrderDocument } from "./alemiApi.service.js";
import { MAX_DOCUMENT_BYTES, MAX_IMAGE_BYTES } from "./inboundGuard.service.js";

export interface ReceiptDeliveryInput {
  instanceId: string;
  phone: string;
  orderNumber: string;
  config: Record<string, any>;
  amount: number;
  senderName: string;
  bankName: string;
  transactionId?: string;
  paidAt?: string;
  receiptBase64: string;
  mimeType: string;
  sourceMessageId: string;
}

export type ReceiptDeliveryResult =
  | { success: true; deliveryId: string; deliveredAt: string }
  | { success: false; errorCode: string; safeMessage: string };

type ReceiptSender = typeof uploadOrderDocument;

function failure(errorCode: string, safeMessage: string): ReceiptDeliveryResult {
  return { success: false, errorCode, safeMessage };
}

export async function deliverReceiptToClient(input: ReceiptDeliveryInput, sendReceipt: ReceiptSender = uploadOrderDocument): Promise<ReceiptDeliveryResult> {
  const orderNumber = String(input.orderNumber || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  if (!orderNumber || !phone) {
    auditError("Receipt delivery target invalid", new Error("invalid_recipient"), { instanceId: input.instanceId, orderNumber: orderNumber || "-", hasPhone: Boolean(phone) });
    return failure("invalid_recipient", "receipt_delivery_target_invalid");
  }

  const mimeType = String(input.mimeType || "").split(";", 1)[0].trim().toLowerCase();
  const allowedMimeTypes = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "application/pdf"]);
  if (!allowedMimeTypes.has(mimeType)) {
    auditError("Receipt media type rejected", new Error("invalid_receipt_media"), { instanceId: input.instanceId, orderNumber, mimeType });
    return failure("invalid_receipt_media", "receipt_media_type_invalid");
  }

  // hydrateInboundMedia hands over a data URL ("data:application/pdf;base64,…").
  // The prefix failed the plain-base64 check, so the upload was never attempted
  // and the guest heard "чекті операторға жібере алмадым" for a perfectly valid
  // receipt (live, 2026-08-14). Strip the prefix before validating.
  const rawEncoded = String(input.receiptBase64 || "").replace(/\s+/g, "");
  const encoded = rawEncoded.replace(/^data:[^,]*;base64,/i, "");
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    auditError("Receipt media failed validation", new Error("invalid_receipt_media"), { instanceId: input.instanceId, orderNumber, hadDataUrlPrefix: /^data:/i.test(rawEncoded) });
    return failure("invalid_receipt_media", "receipt_media_invalid");
  }
  const bytes = Buffer.from(encoded, "base64");
  const maxBytes = mimeType === "application/pdf" ? MAX_DOCUMENT_BYTES : MAX_IMAGE_BYTES;
  if (!bytes.byteLength || bytes.byteLength > maxBytes) {
    auditError("Receipt media size invalid", new Error(bytes.byteLength ? "receipt_too_large" : "invalid_receipt_media"), { instanceId: input.instanceId, orderNumber, bytes: bytes.byteLength });
    return failure(bytes.byteLength ? "receipt_too_large" : "invalid_receipt_media", bytes.byteLength ? "receipt_media_too_large" : "receipt_media_invalid");
  }

  // The operator verifies the payment against this line, not against a generic
  // "клиент отправил чек": sender name, amount and bank, short and readable
  // (product rule, 2026-08-14: "Рахметоллаұлы Б 8000 ₸ kaspi").
  const noteParts = [
    String(input.senderName || "").trim(),
    Number(input.amount) > 0 ? `${Number(input.amount)} ₸` : "",
    String(input.bankName || "").trim(),
  ].filter(Boolean);
  const note = noteParts.join(" ").replace(/\s{2,}/g, " ").trim().slice(0, 200);

  let response: any;
  try {
    response = await sendReceipt({
      instanceId: input.instanceId,
      orderId: orderNumber,
      sourceMessageId: String(input.sourceMessageId || "").trim(),
      bytes,
      mimeType,
      documentKind: "receipt",
      ...(note ? { note } : {}),
    }, { config: input.config });
  } catch (error) {
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

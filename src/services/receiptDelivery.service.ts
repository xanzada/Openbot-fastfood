import { auditError, auditOutbound } from "./auditLogger.service.js";
import { reportAnalyzedReceipt, uploadOrderDocument } from "./alemiApi.service.js";
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
type ReceiptAnalysisSender = typeof reportAnalyzedReceipt;

export interface ReceiptDeliveryDependencies {
  sendAnalysis?: ReceiptAnalysisSender;
  sendDocument?: ReceiptSender;
}

type ReceiptDeliveryAdapter = ReceiptSender | ReceiptDeliveryDependencies;

function failure(errorCode: string, safeMessage: string): ReceiptDeliveryResult {
  return { success: false, errorCode, safeMessage };
}

export function formatReceiptOperatorComment(input: Pick<ReceiptDeliveryInput, "senderName" | "amount" | "bankName">) {
  const sender = String(input.senderName || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const senderWithInitial = /(?:^|\s)\p{L}$/u.test(sender) ? `${sender}.` : sender;
  const amount = Number(input.amount);
  const bank = String(input.bankName || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
  return [
    senderWithInitial,
    Number.isFinite(amount) && amount > 0 ? `сумма ${amount} ₸` : "",
    bank,
  ].filter(Boolean).join(" ").slice(0, 200);
}

function receiptDeliveryDependencies(adapter?: ReceiptDeliveryAdapter) {
  // A function is the pre-migration test/injection shape and intentionally
  // exercises the legacy document path. Production passes nothing and always
  // probes the structured command first.
  if (typeof adapter === "function") {
    return { sendAnalysis: null, sendDocument: adapter };
  }
  return {
    sendAnalysis: adapter?.sendAnalysis || reportAnalyzedReceipt,
    sendDocument: adapter?.sendDocument || uploadOrderDocument,
  };
}

function errorResponseData(error: any) {
  return error?.response?.data ?? error?.responseData ?? error?.data ?? null;
}

export function isAnalyzedReceiptCommandUnsupported(error: any) {
  const status = Number(error?.statusCode ?? error?.response?.status ?? 0);
  const data = errorResponseData(error);
  // Axios uses its own generic ERR_BAD_REQUEST code at the top level. Prefer
  // Hub's structured business code so an explicit unsupported-command reply is
  // not mistaken for a transport failure.
  const codes = [
    data?.error?.code,
    data?.error_code,
    data?.code,
    error?.alemiCode,
    error?.code,
  ].map((value) => String(value || "").trim().toUpperCase()).filter(Boolean);
  const detail = JSON.stringify(data || "").toUpperCase();
  if (![400, 404, 422].includes(status)) return false;
  if (codes.some((code) => /UNSUPPORTED|UNKNOWN_COMMAND|COMMAND_NOT_IMPLEMENTED|INTEGRATION_COMMAND_INVALID/.test(code))) return true;
  return status === 422 && /COMMAND|ORDER\.PAYMENT_RECEIPT\.ANALYZED/.test(detail);
}

export async function deliverReceiptToClient(input: ReceiptDeliveryInput, adapter?: ReceiptDeliveryAdapter): Promise<ReceiptDeliveryResult> {
  const orderNumber = String(input.orderNumber || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  if (!orderNumber || !phone) {
    auditError("Receipt delivery target invalid", new Error("invalid_recipient"), { instanceId: input.instanceId, orderNumber: orderNumber || "-", hasPhone: Boolean(phone) });
    return failure("invalid_recipient", "receipt_delivery_target_invalid");
  }

  const dependencies = receiptDeliveryDependencies(adapter);
  const note = formatReceiptOperatorComment(input);

  if (dependencies.sendAnalysis) {
    try {
      const response: any = await dependencies.sendAnalysis({
        instanceId: input.instanceId,
        orderId: orderNumber,
        sourceMessageId: String(input.sourceMessageId || "").trim(),
        phone,
        senderName: input.senderName,
        amount: input.amount,
        bankName: input.bankName,
      }, { config: input.config });
      const deliveredOrderNumber = String(response?.order_id || orderNumber).trim();
      if (deliveredOrderNumber !== orderNumber) {
        throw Object.assign(new Error("RECEIPT_ANALYSIS_DELIVERY_UNCONFIRMED"), { deliveredOrderNumber });
      }
      const deliveredAt = String(response?.received_at || response?.created_at || response?.updated_at || new Date().toISOString());
      const deliveryId = String(response?.receipt_analysis_id || response?.payment_receipt_id || response?.event_id || `receipt-analysis:${orderNumber}:${input.sourceMessageId}`);
      auditOutbound("Receipt analysis to Alemi confirmed", {
        instanceId: input.instanceId,
        orderNumber,
        deliveryId,
        deliveredAt,
        amountMinor: Math.round(Number(input.amount || 0) * 100),
        hasSenderName: Boolean(String(input.senderName || "").trim()),
        hasBankName: Boolean(String(input.bankName || "").trim()),
      });
      return { success: true, deliveryId, deliveredAt };
    } catch (error) {
      if (!isAnalyzedReceiptCommandUnsupported(error)) {
        auditError("Receipt analysis delivery to Alemi failed", error, {
          instanceId: input.instanceId,
          orderNumber,
          sourceMessageId: input.sourceMessageId,
        });
        return failure("delivery_failed", "receipt_delivery_failed");
      }
      auditOutbound("Analyzed receipt command unsupported; using temporary document fallback", {
        instanceId: input.instanceId,
        orderNumber,
      });
    }
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

  // Hub's current direct-API contract still requires the raw document upload,
  // but its operator note must contain only the extracted payment facts.
  let response: any;
  try {
    response = await dependencies.sendDocument({
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
    hasOperatorNote: Boolean(note),
  });
  return { success: true, deliveryId, deliveredAt };
}

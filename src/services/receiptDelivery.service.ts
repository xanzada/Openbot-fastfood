import { auditError, auditOutbound } from "./auditLogger.service.js";
import { updateCrmAction } from "./dle.service.js";

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
}

export type ReceiptDeliveryResult =
  | { success: true; deliveryId: string; deliveredAt: string }
  | { success: false; errorCode: string; safeMessage: string };

type ReceiptSender = typeof updateCrmAction;

function receiptText(input: ReceiptDeliveryInput) {
  const parts = [
    `amount=${Math.max(0, Number(input.amount) || 0)}`,
    `sender=${String(input.senderName || "").trim().slice(0, 120)}`,
    `bank=${String(input.bankName || "").trim().slice(0, 40)}`,
  ];
  if (input.transactionId) parts.push(`transaction=${String(input.transactionId).trim().slice(0, 120)}`);
  if (input.paidAt) parts.push(`paid_at=${String(input.paidAt).trim().slice(0, 80)}`);
  return `payment_receipt ${parts.join("; ")}`;
}

function failure(errorCode: string, safeMessage: string): ReceiptDeliveryResult {
  return { success: false, errorCode, safeMessage };
}

export async function deliverReceiptToClient(input: ReceiptDeliveryInput, sendReceipt: ReceiptSender = updateCrmAction): Promise<ReceiptDeliveryResult> {
  const orderNumber = String(input.orderNumber || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  if (!orderNumber || !phone) return failure("invalid_recipient", "receipt_delivery_target_invalid");

  const response = await sendReceipt("receipt", input.instanceId, phone, {
    config: input.config,
    amount: input.amount,
    amount_paid: input.amount,
    sender_name: input.senderName,
    bank_name: input.bankName,
    order_id: orderNumber,
    receipt_text: receiptText(input),
  });

  const deliveredOrderNumber = String(response?.order_id || "").trim();
  if (response?.success !== true || deliveredOrderNumber !== orderNumber) {
    auditError("Receipt delivery was not confirmed by DLE", new Error("RECEIPT_DELIVERY_UNCONFIRMED"), {
      instanceId: input.instanceId,
      orderNumber,
      responseSuccess: response?.success === true,
      deliveredOrderNumber,
    });
    return failure("delivery_unconfirmed", "receipt_delivery_unconfirmed");
  }

  const deliveredAt = String(response.delivered_at || new Date().toISOString());
  const deliveryId = String(response.delivery_id || `receipt:${orderNumber}:${deliveredAt}`);
  auditOutbound("Receipt delivery confirmed", { instanceId: input.instanceId, orderNumber, deliveryId, deliveredAt });
  return { success: true, deliveryId, deliveredAt };
}

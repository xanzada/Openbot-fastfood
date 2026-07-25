import { auditError, auditOutbound } from "./auditLogger.service.js";
import { updateCrmAction } from "./dle.service.js";
function receiptText(input) {
  const amount = Math.max(0, Number(input.amount) || 0);
  const sender = String(input.senderName || "").trim().slice(0, 120);
  const bank = String(input.bankName || "").trim().slice(0, 40).toUpperCase();
  return `\u0441\u0443\u043C\u043C\u0430: ${amount}, \u043E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u0435\u043B\u044C: ${sender}${bank ? ` (${bank})` : ""}`;
}
function failure(errorCode, safeMessage) {
  return { success: false, errorCode, safeMessage };
}
async function deliverReceiptToClient(input, sendReceipt = updateCrmAction) {
  const orderNumber = String(input.orderNumber || "").trim();
  const phone = String(input.phone || "").replace(/\D/g, "");
  if (!orderNumber || !phone) return failure("invalid_recipient", "receipt_delivery_target_invalid");
  const response = await sendReceipt("receipt", input.instanceId, phone, {
    config: input.config,
    amount: input.amount,
    amount_paid: input.amount,
    sender_name: input.senderName,
    bank_name: input.bankName,
    transaction_id: input.transactionId,
    date_time: input.paidAt,
    order_id: orderNumber,
    receipt_text: receiptText(input)
  });
  const deliveredOrderNumber = String(response?.order_id || "").trim();
  if (response?.success !== true || deliveredOrderNumber !== orderNumber) {
    auditError("Receipt delivery was not confirmed by DLE", new Error("RECEIPT_DELIVERY_UNCONFIRMED"), {
      instanceId: input.instanceId,
      orderNumber,
      responseSuccess: response?.success === true,
      deliveredOrderNumber
    });
    return failure("delivery_unconfirmed", "receipt_delivery_unconfirmed");
  }
  const deliveredAt = String(response.delivered_at || (/* @__PURE__ */ new Date()).toISOString());
  const deliveryId = String(response.delivery_id || `receipt:${orderNumber}:${deliveredAt}`);
  auditOutbound("Receipt delivery confirmed", { instanceId: input.instanceId, orderNumber, deliveryId, deliveredAt });
  return { success: true, deliveryId, deliveredAt };
}
export {
  deliverReceiptToClient
};

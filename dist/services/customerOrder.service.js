import { auditError } from "./auditLogger.service.js";
import { getOrderContext, normalizePhone } from "./dle.service.js";
function statusKey(status) {
  return String(status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}
function hasPaymentRequest(aiComment) {
  return String(aiComment || "").toUpperCase().includes("[PAY_REQ]");
}
function hasReceiptMarker(aiComment) {
  const value = String(aiComment || "").trim();
  return /\[RECEIPT(?:_REVIEW)?\]/i.test(value) || /^сумма:\s*.+,\s*отправитель:\s*.+\s+\([^)]+\)$/iu.test(value);
}
function classifyOrderStage(status, aiComment = "") {
  const key = statusKey(status);
  if (key === "pending") {
    if (hasPaymentRequest(aiComment)) return "awaiting_receipt";
    if (hasReceiptMarker(aiComment)) return "receipt_review";
    return "awaiting_confirmation";
  }
  if (key === "paid") return "preparing";
  if (key === "delivery") return "delivery";
  if (key === "completed") return "completed";
  if (key === "cancelled" || key === "canceled") return "cancelled";
  return "unknown";
}
function describeOrderStage(stage, language) {
  const labels = language === "ru" ? {
    awaiting_confirmation: ["\u041D\u043E\u0432\u044B\u0439", "\u0437\u0430\u043A\u0430\u0437 \u043F\u043E\u043B\u0443\u0447\u0435\u043D \u0438 \u043E\u0436\u0438\u0434\u0430\u0435\u0442 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F \u0440\u0435\u0441\u0442\u043E\u0440\u0430\u043D\u0430"],
    awaiting_receipt: ["\u0416\u0434\u0451\u043C \u0447\u0435\u043A", "\u0440\u0435\u043A\u0432\u0438\u0437\u0438\u0442\u044B \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D\u044B, \u043E\u0436\u0438\u0434\u0430\u0435\u043C \u0447\u0435\u043A \u043E\u0431 \u043E\u043F\u043B\u0430\u0442\u0435"],
    receipt_review: ["\u0427\u0435\u043A \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u0435\u043D", "\u0447\u0435\u043A \u043F\u043E\u043B\u0443\u0447\u0435\u043D \u0438 \u043E\u0436\u0438\u0434\u0430\u0435\u0442 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440\u0430"],
    preparing: ["\u0413\u043E\u0442\u043E\u0432\u0438\u0442\u0441\u044F", "\u043E\u043F\u043B\u0430\u0442\u0430 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0430, \u0437\u0430\u043A\u0430\u0437 \u0433\u043E\u0442\u043E\u0432\u0438\u0442\u0441\u044F"],
    delivery: ["\u0412 \u043F\u0443\u0442\u0438", "\u0437\u0430\u043A\u0430\u0437 \u0443 \u043A\u0443\u0440\u044C\u0435\u0440\u0430 \u0438 \u0435\u0434\u0435\u0442 \u043A \u0432\u0430\u043C"],
    completed: ["\u0417\u0430\u0432\u0435\u0440\u0448\u0451\u043D", "\u0437\u0430\u043A\u0430\u0437 \u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043D"],
    cancelled: ["\u041E\u0442\u043C\u0435\u043D\u0451\u043D", "\u0437\u0430\u043A\u0430\u0437 \u043E\u0442\u043C\u0435\u043D\u0451\u043D"],
    unknown: ["\u0421\u0442\u0430\u0442\u0443\u0441 \u043E\u0431\u043D\u043E\u0432\u043B\u0451\u043D", "\u0442\u043E\u0447\u043D\u044B\u0439 \u044D\u0442\u0430\u043F \u043F\u043E\u043A\u0430 \u043D\u0435 \u043E\u043F\u0440\u0435\u0434\u0435\u043B\u0451\u043D"]
  } : {
    awaiting_confirmation: ["\u0416\u0430\u04A3\u0430", "\u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043D\u0434\u044B \u0436\u04D9\u043D\u0435 \u0440\u0435\u0441\u0442\u043E\u0440\u0430\u043D \u0440\u0430\u0441\u0442\u0430\u0443\u044B\u043D \u043A\u04AF\u0442\u0443\u0434\u0435"],
    awaiting_receipt: ["\u0427\u0435\u043A \u043A\u04AF\u0442\u0443\u0434\u0435\u043C\u0456\u0437", "\u0440\u0435\u043A\u0432\u0438\u0437\u0438\u0442\u0442\u0435\u0440 \u0436\u0456\u0431\u0435\u0440\u0456\u043B\u0434\u0456, \u0442\u04E9\u043B\u0435\u043C \u0447\u0435\u0433\u0456\u043D \u043A\u04AF\u0442\u0456\u043F \u0442\u04B1\u0440\u043C\u044B\u0437"],
    receipt_review: ["\u0427\u0435\u043A \u0436\u0456\u0431\u0435\u0440\u0456\u043B\u0434\u0456", "\u0447\u0435\u043A \u0430\u043B\u044B\u043D\u0434\u044B \u0436\u04D9\u043D\u0435 \u043E\u043F\u0435\u0440\u0430\u0442\u043E\u0440 \u0442\u0435\u043A\u0441\u0435\u0440\u0443\u0456\u043D \u043A\u04AF\u0442\u0443\u0434\u0435"],
    preparing: ["\u0414\u0430\u0439\u044B\u043D\u0434\u0430\u043B\u0443\u0434\u0430", "\u0442\u04E9\u043B\u0435\u043C \u0440\u0430\u0441\u0442\u0430\u043B\u0434\u044B, \u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0434\u0430\u0439\u044B\u043D\u0434\u0430\u043B\u044B\u043F \u0436\u0430\u0442\u044B\u0440"],
    delivery: ["\u0416\u043E\u043B\u0434\u0430", "\u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u043A\u0443\u0440\u044C\u0435\u0440\u0434\u0435 \u0436\u04D9\u043D\u0435 \u0441\u0456\u0437\u0433\u0435 \u043A\u0435\u043B\u0435 \u0436\u0430\u0442\u044B\u0440"],
    completed: ["\u0410\u044F\u049B\u0442\u0430\u043B\u0434\u044B", "\u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441 \u0430\u044F\u049B\u0442\u0430\u043B\u0434\u044B"],
    cancelled: ["\u0411\u0430\u0441 \u0442\u0430\u0440\u0442\u044B\u043B\u0434\u044B", "\u0442\u0430\u043F\u0441\u044B\u0440\u044B\u0441\u0442\u0430\u043D \u0431\u0430\u0441 \u0442\u0430\u0440\u0442\u044B\u043B\u0434\u044B"],
    unknown: ["\u0421\u0442\u0430\u0442\u0443\u0441 \u0436\u0430\u04A3\u0430\u0440\u0442\u044B\u043B\u0434\u044B", "\u043D\u0430\u049B\u0442\u044B \u043A\u0435\u0437\u0435\u04A3\u0456 \u04D9\u0437\u0456\u0440\u0433\u0435 \u0430\u043D\u044B\u049B\u0442\u0430\u043B\u043C\u0430\u0434\u044B"]
  };
  const value = labels[stage];
  return { label: value[0], explanation: value[1] };
}
function describeOrderStatus(status, language, aiComment = "") {
  return describeOrderStage(classifyOrderStage(status, aiComment), language).explanation;
}
function customerItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const name = String(item?.name || item?.title || "").trim().slice(0, 120);
    const quantity = Math.max(1, Math.min(99, Number(item?.qty || item?.quantity || item?.count || 1) || 1));
    return name ? { name, quantity } : null;
  }).filter((x) => Boolean(x));
}
function customerOrderFromRecord(value, expectedPhone, language) {
  const record = value?.order || value?.active_order || value || null;
  const orderNumber = String(record?.id || record?.order_id || value?.order_id || "").trim().slice(0, 40);
  const status = String(record?.status || value?.status || "").trim().slice(0, 80);
  if (!orderNumber || !status) return { state: "not_found" };
  const ownerPhone = normalizePhone(record?.phone || value?.phone || "");
  const requestedPhone = normalizePhone(expectedPhone);
  if (ownerPhone && requestedPhone && ownerPhone !== requestedPhone) {
    auditError("Customer order ownership mismatch", new Error("ORDER_PHONE_MISMATCH"), { orderNumber, expectedPhone: requestedPhone, ownerPhone });
    return { state: "not_found" };
  }
  const stage = classifyOrderStage(status, record?.ai_comment || value?.ai_comment);
  const description = describeOrderStage(stage, language);
  return { state: "found", order: { orderNumber, status, stage, statusLabel: description.label, statusExplanation: description.explanation, items: customerItems(record?.items || value?.items) } };
}
function customerOrderFromContext(context, expectedPhone, language, hasRequestedOrderNumber = false) {
  if (!context) return { state: "not_found" };
  if (context.is_stale) return { state: "unavailable" };
  if (Array.isArray(context.active_orders) && context.active_orders.length > 1 && !hasRequestedOrderNumber) return { state: "ambiguous" };
  return customerOrderFromRecord(context, expectedPhone, language);
}
async function getCustomerOrder(instanceId, domain, phone, language, orderNumber) {
  try {
    const context = await getOrderContext(instanceId, domain, { phone, orderId: orderNumber });
    return customerOrderFromContext(context, phone, language, Boolean(orderNumber));
  } catch (error) {
    auditError("Customer order lookup failed", error, { instanceId, orderNumber: orderNumber || "", phone: normalizePhone(phone) });
    return { state: "unavailable" };
  }
}
function formatCustomerOrderStatus(order, language) {
  const items = order.items.slice(0, 8).map((i) => `${i.name} \xD7${i.quantity}`).join(", ");
  if (language === "ru") return items ? `\u0417\u0430\u043A\u0430\u0437 #${order.orderNumber}: ${order.statusLabel} \u2014 ${order.statusExplanation}. \u0421\u043E\u0441\u0442\u0430\u0432: ${items}.` : `\u0417\u0430\u043A\u0430\u0437 #${order.orderNumber}: ${order.statusLabel} \u2014 ${order.statusExplanation}.`;
  return items ? `\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 #${order.orderNumber}: ${order.statusLabel} \u2014 ${order.statusExplanation}. \u049A\u04B1\u0440\u0430\u043C\u044B: ${items}.` : `\u0422\u0430\u043F\u0441\u044B\u0440\u044B\u0441 #${order.orderNumber}: ${order.statusLabel} \u2014 ${order.statusExplanation}.`;
}
export {
  classifyOrderStage,
  customerOrderFromContext,
  customerOrderFromRecord,
  describeOrderStage,
  describeOrderStatus,
  formatCustomerOrderStatus,
  getCustomerOrder
};

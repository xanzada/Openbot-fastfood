import { paymentFieldsFrom } from "../utils/paymentTiming.js";

// Payment policy the agent speaks from (updated 2026-10-04, hub PAYMENT_TIMING.md).
// Prepayment by transfer + receipt stays the default. A restaurant may also let
// the guest choose «При получении» at checkout; the bot cannot see that setting,
// so it neither promises nor denies it - the checkout link shows the option when
// it exists. The choice made for a concrete order is a fact the bot does see.
export const PAYMENT_POLICY = Object.freeze({
  mode: "prepay_default_on_receipt_optional" as const,
  defaultTiming: "prepay" as const,
  prepayment:
    "Default flow: after the restaurant confirms the order, the guest transfers the sum by the live requisites (getPaymentDetails) and sends the receipt to this chat.",
  payOnReceipt:
    "Some restaurants let the guest choose «При получении» / «Алған кезде» in the checkout link; the choice is made in the link and the restaurant may change it on the order. When asked, say the guest can pick it in the link if the option is shown there, otherwise prepayment applies. Never promise it is available and never say it is impossible.",
  rule:
    "Never send requisites or ask for a receipt for an order whose payment timing is on_receipt. Never say a payment arrived unless checkOrderStatus shows it. How exactly the guest pays on receipt is not specified - do not invent cash, card terminals or courier rules.",
});

export type PaymentPolicyView = typeof PAYMENT_POLICY & {
  active_order_payment_timing: "prepay" | "on_receipt" | "no_active_order";
  active_order_rule?: string;
};

export function paymentPolicyForOrder(order: unknown): PaymentPolicyView {
  const record = order && typeof order === "object" ? (order as Record<string, any>) : null;
  const target = record ? record.order || record.active_order || record : null;
  const timing = target ? paymentFieldsFrom(target).timing : null;
  const active = target ? (timing === "on_receipt" ? "on_receipt" : "prepay") : "no_active_order";
  return {
    ...PAYMENT_POLICY,
    active_order_payment_timing: active,
    ...(active === "on_receipt"
      ? { active_order_rule: "The guest's current order is paid on receipt: no requisites, no receipt - they pay when they get the order." }
      : {}),
  };
}

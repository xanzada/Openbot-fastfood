// Payment timing contract (hub PAYMENT_TIMING.md, 2026-10-04).
//
// A restaurant may let the guest choose at checkout between the classic
// prepayment by transfer + receipt ("prepay") and paying when the order is
// handed over ("on_receipt"). The choice travels on every order event as
// payment_timing / payment_revision / receipt_required. A missing or null
// timing is a legacy order and keeps the old prepayment flow - it is NOT
// proof of payment and NOT a pay-on-receipt order.
//
// Pure helpers only: dle.service and the payment timing service both import
// this file, so it must not import any service itself.

export type PaymentTiming = "prepay" | "on_receipt";

export interface PaymentFields {
  timing: PaymentTiming | null;
  revision: number | null;
  receiptRequired: boolean | null;
}

const ON_RECEIPT_WORDS = new Set([
  "on_receipt",
  "onreceipt",
  "pay_on_receipt",
  "payment_on_receipt",
  "on_delivery",
  "pay_on_delivery",
  "postpay",
  "postpaid",
]);
const PREPAY_WORDS = new Set(["prepay", "prepaid", "prepayment", "pre_pay", "online_prepayment"]);

export function normalizePaymentTiming(value: unknown): PaymentTiming | null {
  const key = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!key) return null;
  if (ON_RECEIPT_WORDS.has(key)) return "on_receipt";
  if (PREPAY_WORDS.has(key)) return "prepay";
  return null;
}

export function parsePaymentRevision(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const raw = String(value).trim();
  if (!/^\d{1,9}$/.test(raw)) return null;
  const revision = Number(raw);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

export function parseReceiptRequired(value: unknown): boolean | null {
  if (value === true || value === false) return value;
  if (value === null || value === undefined) return null;
  const key = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(key)) return true;
  if (["0", "false", "no", "n"].includes(key)) return false;
  return null;
}

function pick(record: Record<string, any>, ...keys: string[]) {
  for (const key of keys) {
    const value = record?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return undefined;
}

export function paymentFieldsFrom(value: unknown): PaymentFields {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : {};
  const nested = record.payment && typeof record.payment === "object" && !Array.isArray(record.payment)
    ? (record.payment as Record<string, any>)
    : {};
  const timing = normalizePaymentTiming(pick(record, "payment_timing", "paymentTiming") ?? pick(nested, "timing", "payment_timing"));
  let revision = parsePaymentRevision(pick(record, "payment_revision", "paymentRevision") ?? pick(nested, "revision", "payment_revision"));
  // "Without a revision only the original flow with payment_revision = 1 is
  // allowed": a timing that arrives without its revision is the first one.
  if (timing && revision === null) revision = 1;
  const receiptRequired = parseReceiptRequired(
    pick(record, "receipt_required", "receiptRequired") ?? pick(nested, "receipt_required", "receiptRequired"),
  );
  return { timing, revision, receiptRequired };
}

export function hasPaymentFields(fields: PaymentFields | null | undefined) {
  return Boolean(fields && (fields.timing || fields.revision !== null || fields.receiptRequired !== null));
}

export function isOnReceipt(fields: Pick<PaymentFields, "timing"> | null | undefined) {
  return fields?.timing === "on_receipt";
}

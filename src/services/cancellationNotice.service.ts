export type CancellationNoticeKind = "unpaid" | "out_of_stock" | "neutral";

export type CancellationNoticeDecision = {
  kind: CancellationNoticeKind;
  evidence: "trusted_code" | "consistent_reason" | "safe_default";
};

export type CancellationNoticeFacts = {
  reason?: unknown;
  reasonCode?: unknown;
  receiptSeen: boolean;
  notifyCursor: { rank: number; status: string } | null;
  evidenceAvailable?: boolean;
};

const OUT_OF_STOCK_CODES = new Set([
  "out_of_stock",
  "item_unavailable",
  "dish_unavailable",
  "product_unavailable",
  "sold_out",
]);

const UNPAID_CODES = new Set([
  "unpaid",
  "payment_timeout",
  "payment_not_received",
  "no_payment",
]);

const OUT_OF_STOCK_REASON_RE =
  /(?:нет\s+(?:в\s+наличии|блюд[ао]?|товар[ао]?)|отсутству\p{L}*|закончил\p{L}*|блюд\p{L}*\s+нет|тағам\p{L}*\s+жоқ|бітіп\s+қал\p{L}*|қалмады|қолжетімсіз|ас\s*үйде\s+жоқ)/iu;
const UNPAID_REASON_RE =
  /(?:payment\s*(?:timeout|not\s+received)|\bunpaid\b|не\s+оплачен\p{L}*|оплат\p{L}*\s+не\s+поступил\p{L}*|ист[её]к\p{L}*\s+срок\p{L}*\s+оплат\p{L}*|төлем\p{L}*\s+(?:жасалма\p{L}*|түспе\p{L}*|келіп\s+түспе\p{L}*))/iu;
const UNPAID_CONTRADICTION_RE =
  /(?:оплат\p{L}*\s+(?:поступил\p{L}*|получен\p{L}*|прошл\p{L}*|есть)|төлем\p{L}*\s+(?:түст\p{L}*|жасалд\p{L}*|төленд\p{L}*)|\bpaid\b|чек\p{L}*\s+(?:жібер\p{L}*|отправ\p{L}*))/iu;
const AFFIRMATIVE_PAID_RE =
  /(?:^|[\s,;.!?])(?<!не\s)(?:(?:заказ|он|клиент)\s+)?(?:уже\s+)?(?:оплачен\p{L}*|оплатил\p{L}*)(?=\s|[.!?,;:]|$)/iu;

function hasAffirmativePaymentContradiction(reason: string): boolean {
  return UNPAID_CONTRADICTION_RE.test(reason) || AFFIRMATIVE_PAID_RE.test(reason);
}

function normalizeCode(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function paymentWasRequested(cursor: CancellationNoticeFacts["notifyCursor"]): boolean {
  return Boolean(cursor && cursor.rank === 1 && cursor.status === "request_payment");
}

/**
 * Chooses a cancellation notice only from facts that agree with each other.
 * A receipt marker means the guest sent evidence, not that payment was accepted.
 * Likewise, request_payment without a receipt is not proof of non-payment.
 */
export function decideCancellationNotice(facts: CancellationNoticeFacts): CancellationNoticeDecision {
  const code = normalizeCode(facts.reasonCode);
  const reason = String(facts.reason || "").replace(/\s+/g, " ").trim();

  if (OUT_OF_STOCK_CODES.has(code)) {
    return { kind: "out_of_stock", evidence: "trusted_code" };
  }

  if (UNPAID_CODES.has(code)) {
    if (facts.evidenceAvailable !== false && !facts.receiptSeen && paymentWasRequested(facts.notifyCursor)) {
      return { kind: "unpaid", evidence: "trusted_code" };
    }
    return { kind: "neutral", evidence: "safe_default" };
  }

  // Free-text reasons need corroborating tenant-scoped state. A Redis error is
  // unknown evidence, never equivalent to "no receipt" or "pre-payment".
  if (facts.evidenceAvailable === false) {
    return { kind: "neutral", evidence: "safe_default" };
  }

  if (
    !facts.receiptSeen
    && paymentWasRequested(facts.notifyCursor)
    && UNPAID_REASON_RE.test(reason)
    && !hasAffirmativePaymentContradiction(reason)
  ) {
    return { kind: "unpaid", evidence: "consistent_reason" };
  }

  if (
    !facts.receiptSeen
    && facts.notifyCursor?.rank === 0
    && facts.notifyCursor.status === "new_order"
    && OUT_OF_STOCK_REASON_RE.test(reason)
  ) {
    return { kind: "out_of_stock", evidence: "consistent_reason" };
  }

  return { kind: "neutral", evidence: "safe_default" };
}

export function buildCancellationNotice(kind: CancellationNoticeKind, lang: "kk" | "ru"): string {
  if (kind === "unpaid") {
    return lang === "ru"
      ? "❌ Заказ пришлось отменить, потому что оплата не поступила. Если хотите заказать снова, выберите блюда по ссылке на меню."
      : "❌ Тапсырысыңыздың төлемі жасалмағандықтан, оны тоқтатуға тура келді. Қайта тапсырыс бергіңіз келсе, мәзір сілтемесі арқылы тағам таңдай аласыз.";
  }
  if (kind === "out_of_stock") {
    return lang === "ru"
      ? "❌ Заказ отменён: одного из блюд сейчас нет в наличии. Вы можете выбрать другое блюдо по ссылке на меню."
      : "❌ Тапсырысыңыз тоқтатылды: тағамдардың бірі қазір жоқ. Басқа тағамды мәзір сілтемесі арқылы таңдай аласыз.";
  }
  return lang === "ru"
    ? "❌ Заказ отменён. Если оплата уже прошла, напишите в этот чат — уточним детали. Повторный заказ можно оформить по ссылке на меню."
    : "❌ Тапсырысыңыз тоқтатылды. Төлем жасап қойған болсаңыз, осы чатқа жазыңыз — мән-жайды анықтаймыз. Қайта тапсырыс бергіңіз келсе, мәзір сілтемесі арқылы рәсімдей аласыз.";
}

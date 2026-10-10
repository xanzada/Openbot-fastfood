import { intentMatches } from "./intentText.js";

const PAYMENT_DETAILS_RE =
  /(реквизит|kaspi|каспи|halyk|халық|оплат\p{L}*|төлем|аудар\p{L}*|перевод).*(?:қалай|қайда|как|куда|номер|счет|шот|сілтеме|ссылка)?/iu;
const RECEIPT_EVENT_RE =
  /(чек(?:ті|ті\s+жібер| отправ| скин)|receipt|түбірте[кг]|квитанц|ақшаны\s+аудар|деньги\s+перев[её]л)/iu;

/** Current payment requisites are a distinct answer path, never checkout-link authority. */
export function isCurrentPaymentDetailsIntent(text: string, orderQuestion: string | null = null): boolean {
  return orderQuestion !== "payment_confirmation"
    && intentMatches(PAYMENT_DETAILS_RE, text)
    && !intentMatches(RECEIPT_EVENT_RE, text);
}

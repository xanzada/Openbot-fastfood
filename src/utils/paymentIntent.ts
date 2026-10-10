import { intentMatches } from "./intentText.js";

const PAYMENT_DETAILS_TOPIC_RE =
  /(?:реквизит\p{L}*|kaspi|каспи|halyk|халық|сч[её]т\p{L}*|шот\p{L}*|оплат\p{L}*|төлем\p{L}*|аудар\p{L}*|перевод\p{L}*)/iu;
const PAYMENT_DETAILS_REQUEST_RE =
  /(?:как|куда|на\s+какой|какие|какой|где|есть(?:\s+другие)?|способ\p{L}*|қалай|қайда|қай|қандай|бар\s*ма|тәсіл\p{L}*|номер|нөмір|сілтеме|ссылка|пришл\p{L}*|отправ\p{L}*|дай(?:те)?|жібер\p{L}*|бер(?:іңіз|ші)?)/iu;
const PAYMENT_DETAILS_BARE_RE =
  /^\s*(?:реквизит\p{L}*|kaspi|каспи|halyk|халық|сч[её]т\p{L}*|шот\p{L}*)\s*[?.!]*\s*$/iu;
const PAYMENT_COMPLETION_RE =
  /(?:оплатил\p{L}*|оплачено|оплата\s+(?:прошла|списалась|успешна)|перев[её]л\p{L}*|төледім|төленді|төлем\s+өтті|аудардым)/iu;
const RECEIPT_EVENT_RE =
  /(чек(?:ті|ті\s+жібер| отправ| скин)|receipt|түбірте[кг]|квитанц|ақшаны\s+аудар|деньги\s+перев[её]л)/iu;

/** Current payment requisites are a distinct answer path, never checkout-link authority. */
export function isCurrentPaymentDetailsIntent(text: string, orderQuestion: string | null = null): boolean {
  return orderQuestion !== "payment_confirmation"
    && intentMatches(PAYMENT_DETAILS_TOPIC_RE, text)
    && (intentMatches(PAYMENT_DETAILS_REQUEST_RE, text) || intentMatches(PAYMENT_DETAILS_BARE_RE, text))
    && !intentMatches(PAYMENT_COMPLETION_RE, text)
    && !intentMatches(RECEIPT_EVENT_RE, text);
}

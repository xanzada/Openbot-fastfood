import { intentMatches } from "./intentText.js";

const ORDER_STATUS_QUESTION_RE =
  /(тапсырысым|заказым|мой\s+заказ|мои\s+заказы|соңғы\s+тапсырыс|последн\p{L}*\s+заказ|order\s+status|тапсырыс.*(?:қайда|кайда|қашан|кашан|дайын|жолда|жеткіз|жеткиз|статус|көрін|корин)|заказ.*(?:где|когда|готов|едет|достав|статус|виден|көрін|корин)|(?:қайда|кайда|қашан|кашан).*(?:тапсырыс|заказ)|(?:где|когда).*(?:заказ|order)|менде.*(?:тапсырыс|заказ).*бар|у\s+меня.*заказ|есть\s+ли.*заказ|статус\s+(?:тапсырыс|заказ|order)|(?:төледім|толедим|оплатил).*(?:тапсырыс|заказ)|(?:тапсырыс|заказ).*(?:төледім|толедим|оплатил))/iu;

const ORDER_NUMBER_RE = /(?:№|#|order\s*|заказ(?:ом|а|у)?\s*|тапсырыс(?:ым|тың|тын)?\s*)(\d{1,12})/iu;

const ACTIVE_ORDER_FOLLOW_UP_RE =
  /((?:че|чё|что)\s*там|ну\s*и|и\s*что|не\s*болды|не\s*жаңалық|не\s*жаналык|нестеватсындар|нестеватсыздар|нестеп\s*жатсындар|нестеп\s*жатырсындар|қалай\s*болып\s*жатыр|калай\s*болып\s*жатыр|как\s*там|дайын\s*ба|дайынба|готов(?:о|а)?\s*ли|готов(?:о|а)?|қашан|кашан|когда|скоро\s*ма|скоро|долго\s*(?:ещ[её])?|сколько\s*(?:ещ[её])?|әлі\s*(?:көп\s*пе|қанша\s*күт)|қанша\s*күт|канша\s*кут|жолда\s*ма|жолдама|курьер|едет|келе\s*жатыр\s*ма|келе\s*жатырма)/iu;

const ORDER_TIMING_QUESTION_RE =
  /(қанша\s*уақыт|канша\s*уакыт|қанша\s*минут|канша\s*минут|қашан\s*жет|кашан\s*жет|қашан\s*әкел|кашан\s*акел|қашан\s*дайын|кашан\s*дайын|жетед[іi]\s*ма|жетед[іi]\s*бе|жетеди\s*ма|жетеди\s*бе|сколько\s*(?:по\s*)?времени|как\s*долго|через\s*сколько|когда\s*привез|когда\s*будет\s*готов|kan?sha\s*ua[kq]yt|ua[kq]ytta\s*jet|kashan\s*jet|kashan\s*dayin|skolko\s*jdat)/iu;

const PROSPECTIVE_ORDER_TIMING_RE =
  /((?:қазір|казир|жаңа|жана|сейчас|новый|если)\s+(?:заказ|тапсырыс).{0,32}(?:берсем|жасасам|берем|жасайм|закажу|оформлю|сделаю|дам)|(?:заказ|тапсырыс).{0,24}(?:берсем|жасасам|берем|закажу|оформлю|сделаю))/iu;

export function isOrderTimingQuestion(text = "") {
  return intentMatches(ORDER_TIMING_QUESTION_RE, text);
}

export function isProspectiveOrderTimingQuestion(text = "") {
  return intentMatches(PROSPECTIVE_ORDER_TIMING_RE, text);
}

const OWNED_ORDER_CLAIM_RE =
  /(тапсырысым|тапсырысымды|тапсырысымның|тапсырысымнын|заказым|заказымды|мо[йея]\s+заказ|моего\s+заказа|мои\s+заказы|наш\s+заказ)/iu;

export function isUnownedOrderTimingQuestion(options: {
  text?: string;
  hasActiveOrder?: boolean;
  quotedOrderNumber?: string;
  discussedOrderNumber?: string;
}) {
  if (options.hasActiveOrder) return false;
  if (options.quotedOrderNumber || options.discussedOrderNumber) return false;
  const text = options.text || "";
  if (intentMatches(OWNED_ORDER_CLAIM_RE, text)) return false;
  return isOrderTimingQuestion(text) || isProspectiveOrderTimingQuestion(text);
}

export function requestedOrderNumber(text = "") {
  return String(String(text || "").match(ORDER_NUMBER_RE)?.[1] || "");
}

export function isCustomerOrderStatusQuestion(text = "") {
  const value = String(text || "");
  return Boolean(requestedOrderNumber(value)) || intentMatches(ORDER_STATUS_QUESTION_RE, value);
}

const MENU_INTENT_RE =
  /(меню|мәзір|мазір|ассортимент|почем|почём|цена|цены|сколько\s*стоит|қанша\s*тұрады|канша\s*турады|канша\s*турад|қанша\s*болады|канша\s*болады|канша\s*болад|қаншадан|каншадан|бағасы|бағасын|багасы|багасын|бар\s*ма|барма|есть\s*ли|что\s*есть|не\s*бар|какие\s*есть|из\s*\p{L}+\s*есть|самый\s*деш[ёе]в|арзан|дешев|скидк|жеңілдік|суши|пицца|ролл|донер|бургер)/iu;

export function hasMenuBrowsingIntent(text = "") {
  return MENU_INTENT_RE.test(String(text || ""));
}

export function isLikelyOrderStatusFollowUp(text = "") {
  const value = String(text || "");
  if (!intentMatches(ACTIVE_ORDER_FOLLOW_UP_RE, value)) return false;
  if (requestedOrderNumber(value) || intentMatches(ORDER_STATUS_QUESTION_RE, value)) return true;
  return !hasMenuBrowsingIntent(value);
}

const DISCUSSED_ORDER_RE = /(?:тапсырыс|заказ)\s*№?\s*#?\s*(\d{1,6})/iu;
const ORDER_NOT_FOUND_RE = /(табылмады|табылған\s*жоқ|табылган\s*жок|жоқ\s*екен|жок\s*екен|не\s*найден|не\s*найдено|отсутствует)/iu;
const DISCUSSED_ORDER_LOOKBACK = 6;

export function lastDiscussedOrderNumber(history: unknown): string {
  if (!Array.isArray(history)) return "";
  let scanned = 0;
  for (let index = history.length - 1; index >= 0 && scanned < DISCUSSED_ORDER_LOOKBACK; index -= 1) {
    const entry: any = history[index];
    const role = String(entry?.role || "");
    if (role !== "assistant" && role !== "model") continue;
    scanned += 1;
    const value = String(entry?.text || entry?.content || "");
    if (ORDER_NOT_FOUND_RE.test(value)) continue;
    const match = DISCUSSED_ORDER_RE.exec(value);
    if (match) return match[1];
  }
  return "";
}

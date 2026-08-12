import { intentMatches } from "./intentText.js";

const ORDER_STATUS_QUESTION_RE =
  /(тапсырысым|заказым|мой\s+заказ|мои\s+заказы|соңғы\s+тапсырыс|последн\p{L}*\s+заказ|order\s+status|тапсырыс.*(?:қайда|қашан|дайын|жолда|жеткіз|статус|көрін)|заказ.*(?:где|когда|готов|едет|достав|статус|виден|көрін)|(?:қайда|қашан).*(?:тапсырыс|заказ)|(?:где|когда).*(?:заказ|order)|менде.*(?:тапсырыс|заказ).*бар|у\s+меня.*заказ|есть\s+ли.*заказ|статус\s+(?:тапсырыс|заказ|order)|(?:төледім|оплатил).*(?:тапсырыс|заказ)|(?:тапсырыс|заказ).*(?:төледім|оплатил))/iu;

const ORDER_NUMBER_RE = /(?:№|#|order\s*|заказ(?:ом|а|у)?\s*|тапсырыс(?:ым|тың)?\s*)(\d{1,12})/iu;

const ACTIVE_ORDER_FOLLOW_UP_RE =
  /((?:че|чё|что)\s*там|ну\s*и|и\s*что|не\s*болды|не\s*жаңалық|қалай\s*болып\s*жатыр|как\s*там|дайын\s*ба|дайынба|готов(?:о|а)?\s*ли|готов(?:о|а)?|қашан|когда|скоро\s*ма|скоро|долго\s*(?:ещ[её])?|сколько\s*(?:ещ[её])?|әлі\s*(?:көп\s*пе|қанша\s*күт)|қанша\s*күт|жолда\s*ма|курьер|едет|келе\s*жатыр\s*ма)/iu;

// "қанша уақытта жетеді?" is the single most common thing a guest writes after
// paying, and it never matched the status patterns, so it fell through to the
// model, which answered that it had no information. A guest who is waiting for
// food they already paid for always gets the deterministic status line instead.
const ORDER_TIMING_QUESTION_RE =
  /(қанша\s*уақыт|қанша\s*минут|қашан\s*жет|қашан\s*әкел|қашан\s*дайын|жетед[іi]\s*ма|жетед[іi]\s*бе|канша\s*уакыт|сколько\s*(?:по\s*)?времени|как\s*долго|через\s*сколько|когда\s*привез|когда\s*будет\s*готов|kan?sha\s*ua[kq]yt|ua[kq]ytta\s*jet|kashan\s*jet|kashan\s*dayin|skolko\s*jdat)/iu;

const PROSPECTIVE_ORDER_TIMING_RE =
  /((?:қазір|казир|жаңа|жана|сейчас|новый|если)\s+(?:заказ|тапсырыс).{0,32}(?:берсем|жасасам|берем|жасайм|закажу|оформлю|сделаю|дам)|(?:заказ|тапсырыс).{0,24}(?:берсем|жасасам|берем|закажу|оформлю|сделаю))/iu;

export function isOrderTimingQuestion(text = "") {
  return intentMatches(ORDER_TIMING_QUESTION_RE, text);
}

export function isProspectiveOrderTimingQuestion(text = "") {
  return intentMatches(PROSPECTIVE_ORDER_TIMING_RE, text);
}

// "Қанша уақыт күтемін, тапсырыс дайын болуы қанша минут?" reads as a status
// question ("тапсырыс ... дайын") and used to be answered with "no active order
// on this number, send the order number". The guest had not ordered yet: the
// only honest answer is the kitchen wait time. The prospective wording
// ("заказ берсем") is just one way to ask it, so the deciding fact is that no
// order is in play at all - none on the phone, none quoted, none discussed.
// "Менің тапсырысым қайда? Қашан жетеді?" claims an order exists. The timing
// words made the status route stand down and the guest was told the kitchen
// cooks without delays - never that no order was found on their number (live
// round, 2026-08-12). Naming an order as theirs is a status question first.
const OWNED_ORDER_CLAIM_RE =
  /(тапсырысым|тапсырысымды|тапсырысымның|заказым|заказымды|мо[йея]\s+заказ|моего\s+заказа|мои\s+заказы|наш\s+заказ)/iu;

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

// "че там у вас из суши есть и почем?" starts exactly like a follow-up
// about a waiting order, but the guest is reading the menu, not waiting for
// food. When the sentence asks what exists or what it costs, the assortment
// wins and the status route stands down.
const MENU_INTENT_RE =
  /(меню|мәзір|ассортимент|почем|почём|цена|цены|сколько\s*стоит|қанша\s*тұрады|бағасы|бағасын|бар\s*ма|барма|есть\s*ли|что\s*есть|какие\s*есть|из\s*\p{L}+\s*есть|самый\s*деш[ёе]в|арзан|дешев|скидк|жеңілдік|суши|пицца|ролл)/iu;

export function hasMenuBrowsingIntent(text = "") {
  return MENU_INTENT_RE.test(String(text || ""));
}

export function isLikelyOrderStatusFollowUp(text = "") {
  const value = String(text || "");
  if (!intentMatches(ACTIVE_ORDER_FOLLOW_UP_RE, value)) return false;
  // An explicit order reference keeps the status route even while browsing.
  if (requestedOrderNumber(value) || intentMatches(ORDER_STATUS_QUESTION_RE, value)) return true;
  return !hasMenuBrowsingIntent(value);
}

// A guest who has been talking about one order all evening does not repeat its
// number in every message. The site can hand us a different "active" order (an
// older pending one), so the conversation itself decides which order the bare
// question "қашан келеді?" is about.
const DISCUSSED_ORDER_RE = /(?:тапсырыс|заказ)\s*№?\s*#?\s*(\d{1,6})/iu;

// Our own "№019 тапсырысы осы нөмір бойынша табылмады" is a sentence about an
// order that does not exist. Reading the number back out of it resurrected a
// dead order number for the rest of the evening: a later bare "тапсырысым
// қайда?" was answered "№019 not found" again, and a plain "how long does
// cooking take?" was answered "you have no active order" instead of the kitchen
// wait time (live round, 2026-08-12).
const ORDER_NOT_FOUND_RE = /(табылмады|табылған\s*жоқ|жоқ\s*екен|не\s*найден|не\s*найдено|отсутствует)/iu;

// How far back a number stays "the order we are talking about". A guest who
// mentioned an order six replies ago and has since moved on to the menu is not
// asking about it any more.
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

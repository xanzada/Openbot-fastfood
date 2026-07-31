const ORDER_STATUS_QUESTION_RE = /(тапсырысым|заказым|мой\s+заказ|мои\s+заказы|order\s+status|тапсырыс.*(?:қайда|қашан|дайын|жолда|жеткіз|статус)|заказ.*(?:где|когда|готов|едет|достав|статус)|(?:қайда|қашан).*(?:тапсырыс|заказ)|(?:где|когда).*(?:заказ|order)|менде.*(?:тапсырыс|заказ).*бар|у\s+меня.*заказ|есть\s+ли.*заказ|статус\s+(?:тапсырыс|заказ|order))/iu;
const ORDER_NUMBER_RE = /(?:№|#|order\s*|заказ\s*|тапсырыс\s*)(\d{1,12})/iu;
const ACTIVE_ORDER_FOLLOW_UP_RE = /((?:че|чё|что)\s*там|не\s*болды|не\s*жаңалық|қалай\s*болып\s*жатыр|как\s*там|дайын\s*ба|дайынба|готов(?:о|а)?\s*ли|готов(?:о|а)?|қашан|когда|скоро\s*ма|скоро|долго\s*(?:ещ[её])?|сколько\s*(?:ещ[её])?|әлі\s*көп\s*пе|жолда\s*ма|курьер|едет|келе\s*жатыр\s*ма)/iu;
// "қанша уақытта жетеді?" is the single most common thing a guest writes after
// paying, and it never matched the status patterns, so it fell through to the
// model, which answered that it had no information. A guest who is waiting for
// food they already paid for always gets the deterministic status line instead.
const ORDER_TIMING_QUESTION_RE = /(қанша\s*уақыт|қанша\s*минут|қашан\s*жет|қашан\s*әкел|қашан\s*дайын|жетед[іi]\s*ма|жетед[іi]\s*бе|канша\s*уакыт|сколько\s*(?:по\s*)?времени|как\s*долго|через\s*сколько|когда\s*привез|когда\s*будет\s*готов|kan?sha\s*ua[kq]yt|ua[kq]ytta\s*jet|kashan\s*jet|kashan\s*dayin|skolko\s*jdat)/iu;
export function isOrderTimingQuestion(text = "") {
    return ORDER_TIMING_QUESTION_RE.test(String(text || ""));
}
export function requestedOrderNumber(text = "") {
    return String(String(text || "").match(ORDER_NUMBER_RE)?.[1] || "");
}
export function isCustomerOrderStatusQuestion(text = "") {
    const value = String(text || "");
    return Boolean(requestedOrderNumber(value)) || ORDER_STATUS_QUESTION_RE.test(value);
}
// "че там у вас из суши есть и почем?" starts exactly like a follow-up
// about a waiting order, but the guest is reading the menu, not waiting for
// food. When the sentence asks what exists or what it costs, the assortment
// wins and the status route stands down.
const MENU_INTENT_RE = /(меню|мәзір|ассортимент|почем|почём|цена|цены|сколько\s*стоит|қанша\s*тұрады|бағасы|бағасын|бар\s*ма|барма|есть\s*ли|что\s*есть|какие\s*есть|из\s*\p{L}+\s*есть|самый\s*деш[ёе]в|арзан|дешев|скидк|жеңілдік|суши|пицца|ролл)/iu;
export function hasMenuBrowsingIntent(text = "") {
    return MENU_INTENT_RE.test(String(text || ""));
}
export function isLikelyOrderStatusFollowUp(text = "") {
    const value = String(text || "");
    if (!ACTIVE_ORDER_FOLLOW_UP_RE.test(value))
        return false;
    // An explicit order reference keeps the status route even while browsing.
    if (requestedOrderNumber(value) || ORDER_STATUS_QUESTION_RE.test(value))
        return true;
    return !hasMenuBrowsingIntent(value);
}
// A guest who has been talking about one order all evening does not repeat its
// number in every message. The site can hand us a different "active" order (an
// older pending one), so the conversation itself decides which order the bare
// question "қашан келеді?" is about.
const DISCUSSED_ORDER_RE = /(?:тапсырыс|заказ)\s*№?\s*#?\s*(\d{1,6})/iu;
export function lastDiscussedOrderNumber(history) {
    if (!Array.isArray(history))
        return "";
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const entry = history[index];
        const role = String(entry?.role || "");
        if (role !== "assistant" && role !== "model")
            continue;
        const match = DISCUSSED_ORDER_RE.exec(String(entry?.text || entry?.content || ""));
        if (match)
            return match[1];
    }
    return "";
}

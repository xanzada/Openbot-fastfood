const ORDER_STATUS_QUESTION_RE = /(тапсырысым|заказым|мой\s+заказ|мои\s+заказы|order\s+status|тапсырыс.*(?:қайда|қашан|дайын|жолда|жеткіз|статус)|заказ.*(?:где|когда|готов|едет|достав|статус)|(?:қайда|қашан).*(?:тапсырыс|заказ)|(?:где|когда).*(?:заказ|order)|менде.*(?:тапсырыс|заказ).*бар|у\s+меня.*заказ|есть\s+ли.*заказ|статус\s+(?:тапсырыс|заказ|order))/iu;
const ORDER_NUMBER_RE = /(?:№|#|order\s*|заказ\s*|тапсырыс\s*)(\d{1,12})/iu;
const ACTIVE_ORDER_FOLLOW_UP_RE = /((?:че|чё|что)\s*там|не\s*болды|не\s*жаңалық|қалай\s*болып\s*жатыр|как\s*там|дайын\s*ба|дайынба|готов(?:о|а)?\s*ли|готов(?:о|а)?|қашан|когда|скоро\s*ма|скоро|долго\s*(?:ещ[её])?|сколько\s*(?:ещ[её])?|әлі\s*көп\s*пе|жолда\s*ма|курьер|едет|келе\s*жатыр\s*ма)/iu;
function requestedOrderNumber(text = "") {
  return String(String(text || "").match(ORDER_NUMBER_RE)?.[1] || "");
}
function isCustomerOrderStatusQuestion(text = "") {
  const value = String(text || "");
  return Boolean(requestedOrderNumber(value)) || ORDER_STATUS_QUESTION_RE.test(value);
}
function isLikelyOrderStatusFollowUp(text = "") {
  return ACTIVE_ORDER_FOLLOW_UP_RE.test(String(text || ""));
}
export {
  isCustomerOrderStatusQuestion,
  isLikelyOrderStatusFollowUp,
  requestedOrderNumber
};

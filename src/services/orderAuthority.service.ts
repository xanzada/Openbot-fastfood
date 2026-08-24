const MANUAL_ORDER_HANDLING_RE =
  /(тапсырыс(?:ыңызды|ты|қа)?[^.!?\n]{0,80}(?:қабылдай\s+аламыз|қабылдадым|қабылдадық|рәсімдедім|расталды)|(?:жеткізу\s+)?мекенжай(?:ыңызды|ын)?[^.!?\n]{0,40}(?:жазыңыз|раста(?:й|ңыз))|приняли\s+адрес|заказ[^.!?\n]{0,100}(?:подтвержд[её]н|оформлен|мы\s+приняли|принимаю)|(?:адрес|доставка|самовывоз)[^.!?\n]{0,60}(?:для\s+заказа|заказ\s+подтверж|подтверд))/iu;

// The mirror image of the claim above, and just as false: the bot cannot cancel an order
// either. Live QA, 2026-08-24: "Ойымды өзгерттім, тапсырысты болдырмаңыз" was answered
// "Жарайды, тапсырысыңызды тоқтатамыз" - the guest walked away believing the order was
// cancelled while the kitchen kept cooking it and no operator had been told. Only a human
// changes order state; the honest reply says the request is going to one.
const MANUAL_ORDER_CANCELLATION_RE =
  /(тапсырыс(?:ыңызды|ты|ыңыз)?[^.!?\n]{0,40}(?:тоқтат(?:тым|тық|амыз|ты|ып\s*қой)|болдырма(?:дым|дық|й\s*қой)|жой(?:дым|дық)|бас\s*тарт(?:тық|тым)|алып\s*тастадым)|заказ[^.!?\n]{0,40}(?:отмен(?:ил|или|яю|им|ён|ен)|аннулир|снял|убрал)|(?:отмен(?:ил|или|яю|им|яем)|аннулир\p{L}*|снял|убрал)[^.!?\n]{0,40}заказ)/iu;

export function isManualOrderCancellationClaim(text: unknown): boolean {
  return MANUAL_ORDER_CANCELLATION_RE.test(String(text || ""));
}

export function manualCancellationBoundaryText(language: unknown): string {
  return language === "kk"
    ? "Тапсырысты өзім тоқтата алмаймын - оны оператор ғана жасайды. Өтінішіңізді операторға жеткіздім, ол сізбен байланысады."
    : "Отменить заказ сам я не могу - это делает только оператор. Вашу просьбу я передал оператору, он свяжется с вами.";
}

export function isManualOrderHandlingClaim(text: unknown): boolean {
  return MANUAL_ORDER_HANDLING_RE.test(String(text || ""));
}

export function manualOrderBoundaryText(language: unknown): string {
  return language === "kk"
    ? "Тапсырыс әлі рәсімделген жоқ. Оны тек жеке мәзір сілтемесі арқылы өзіңіз жасай аласыз."
    : "Заказ ещё не оформлен. Оформить его можно только самостоятельно по персональной ссылке на меню.";
}

import { intentMatches } from "./intentText.js";
import { wantsMenuAsText } from "./magicLink.js";
import { isMenuBudgetInquiry } from "./menuBudget.js";

export const DIRECT_ORDER_INTENT_RE =
  /(?:(?:тапсырыс|заказ)\s*(?:бер|жаса|ет|қыл|хочу|оформ|сдел)|(?:алғым\s*келе|аламын|алайын|хочу\s*заказ|хочу\s*взять)|(?:[1-9]|екі|бір|үш|төрт|бес|алты|жеті|сегіз|тоғыз|он|один|два|три|две)\s*(?:пицц|донер|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кол[ау]|порц)|(?:пицц|донер|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кол[ау]).*(?:жасап|әкел|жеткіз|берші|дайында|алғым|аламын|алайын))/iu;

export function hasDirectOrderIntent(text = ""): boolean {
  const value = String(text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "");
  if (isMenuBudgetInquiry(value)) return false;
  if (DIRECT_ORDER_INTENT_RE.test(value)) return true;
  const food = /(?:пицц|донер|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кока[-\s]*кол|кол[ауы]|cola|спрайт|sprite|фанта|fanta|айран|цезар|комбо)/iu;
  return food.test(value) && /(?:керек|мне|маған|возьму|тогда|дайте|нуж(?:на|ен|ны|но))/iu.test(value)
    && !/(?:бар\s*ма|есть\s*ли|есть[?!.]*\s*$|қанша|сколько|если|болса|жоқ|нет)/iu.test(value);
}

// Link permission follows the customer's current request, never model tool arguments.
export function hasCustomerCheckoutIntent(text = ""): boolean {
  const value = String(text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "");
  const explicitOrderActionRe = /(?:хочу\s*(?:заказать|оформить|сделать\s*заказ|заказ|взять)|закажу|заказываю|оформлю|тапсырыс\s*(?:бер(?:ейін|ей|ем|емін|гім)|жас(?:ай|ағым))|алғым\s*келе|аламын|алайын|(?:жасап|дайындап)\s*(?:бер|қой)|дай(?:те)?\s+\d)/iu;
  const explicitLinkRequestRe = /(?:(?<!\p{L})(?:отправ(?:ь|ьте)|пришл(?:и|ите)|покаж(?:и|ите)|откро(?:й|йте)|жібер(?:ші|іңіз|іңдер)?|жибер(?:ші|иниз|ініз|іңіз)?|аш(?:ып\s*бер(?:іңіз|ші)?|ыңыз|шы)?|көрсет(?:ші|іңіз)?|корсет(?:ші|иниз|ініз|іңіз)?)(?!\p{L})\s*(?:(?:мне|нам|пожалуйста|маған|бізге|қазір|қайта)\s*){0,3}(?:меню|мәзір(?:ді|ін|іңізді)?|мазір(?:ді|ін|іңізді)?|каталог(?:ты|ті|а|у)?|корзин(?:у|а|ы)|себет(?:ті|ін|іңізді)?|ссылк(?:у|а|и)|сілтеме(?:ні|ңізді|мізді)?|линк|link)(?!\p{L})|(?<!\p{L})(?:меню|мәзір(?:ді|ін|іңізді)?|мазір(?:ді|ін|іңізді)?|каталог(?:ты|ті|а|у)?|корзин(?:у|а|ы)|себет(?:ті|ін|іңізді)?|ссылк(?:у|а|и)|сілтеме(?:ні|ңізді|мізді)?|линк|link)(?!\p{L})\s*(?:(?:мне|нам|пожалуйста|маған|бізге|қазір|қайта)\s*){0,3}(?:отправ(?:ь|ьте)|пришл(?:и|ите)|покаж(?:и|ите)|откро(?:й|йте)|жібер(?:ші|іңіз|іңдер)?|жибер(?:ші|иниз|ініз|іңіз)?|аш(?:ып\s*бер(?:іңіз|ші)?|ыңыз|шы)?|көрсет(?:ші|іңіз)?|корсет(?:ші|иниз|ініз|іңіз)?)(?!\p{L}))|(?<!\p{L})(?:мәзірді|мазірді|меню|каталогты|себетті|сілтемені)(?!\p{L})\s*(?:және|мен|и)\s+[^.!?]{0,60}(?:көрсет(?:іңіз|ші)?|корсет(?:иниз|ініз|іңіз|ші)?|покаж(?:ите|и)|жібер(?:іңіз|ші)?|жибер(?:иниз|ініз|іңіз|ші)?)(?!\p{L})/iu;
  const explicitLinkNeedRe = /(?:(?<!\p{L})(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)(?!\p{L})\s*(?:(?:маған|мне|нам|бізге)\s*)?(?:керек|қажет|нуж(?:на|ен|ны|но))(?!\p{L})|(?<!\p{L})(?:керек|қажет|нуж(?:на|ен|ны|но))(?!\p{L})\s*(?:(?:маған|мне|нам|бізге)\s*)?(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)(?!\p{L}))/iu;
  const quantityOrPriceQuestionRe = /(?:қанша|канша|қаншадан|каншадан|сколько|сто(?:ит|ят)|цен[аыу]|бағ[аә]|баг[аә]|поч[её]м|покаж|көрсет|корсет|фото|какие|(?<!\p{L})есть(?!\p{L})|бар\s*ма|состав|из\s*чего)/iu;
  if (quantityOrPriceQuestionRe.test(value) && !explicitOrderActionRe.test(value) && !explicitLinkRequestRe.test(value) && !explicitLinkNeedRe.test(value)) return false;
  // A later explicit decision supersedes an earlier request or refusal. Ordinary
  // questions do not create permission, and quoted customer summaries are removed.
  const clauses = value.split(/[.!?;\n]+|(?<!\p{L})(?:но|бірақ)(?!\p{L})|(?:,\s*|(?<!\p{L})(?:и|және)(?!\p{L})\s+)(?=(?:откро\p{L}*|покаж\p{L}*|жібер\p{L}*|жибер\p{L}*|отправ\p{L}*|пришл\p{L}*|(?:себет|корзин|каталог|меню|мәзір|ссылк|сілтеме)\p{L}*[^,;.!?]{0,20}(?:аш|көрсет|корсет|откр|покаж|жібер|жибер|отправ|пришл|керек|қажет|нуж|не\s+нуж)))/iu);
  let decision = false;
  for (const clause of clauses) {
    const refusedOrder = /(?:не\s+(?:хочу|буду)\s+(?:(?:сделать|оформить)\s*)?(?:заказ|оформ)|не\s+(?:заказыва|заказал)|тапсырыс\s*(?:керек\s*емес|бермей))/iu.test(clause);
    const refusedLinkRu = /(?:не\s+(?:отправ\p{L}*|присыл\p{L}*|пришл\p{L}*|высыла\p{L}*|скидыва\p{L}*|откро\p{L}*|покаж\p{L}*|дай(?:те)?)[^.!?]{0,40}(?:меню|каталог|корзин|ссылк|сілтеме)|(?:меню|каталог|корзин\p{L}*|ссылк\p{L}*|сілтеме\p{L}*)[^.!?]{0,40}не\s+(?:отправ\p{L}*|присыл\p{L}*|пришл\p{L}*|высыла\p{L}*|скидыва\p{L}*|откро\p{L}*|покаж\p{L}*))/iu.test(clause);
    const refusedLinkKk = /(?<!\p{L})(?:жіберме(?:ңіз|ңдер|ші)?|жібермей(?:мін|міз)?|жиберме(?:ніз|ңіз|ндер|ңдер|ші)?|жибермей(?:мін|міз)?|ашпа(?:ңыз|ңдар|шы)?|ашпай(?:мын|мыз)?|көрсетпе(?:ңіз|ңдер|ші)?|көрсетпей(?:мін|міз)?|корсетпе(?:ніз|ңіз|ндер|ңдер|ші)?)(?!\p{L})/iu.test(clause);
    const refusedLinkNeed = /(?:(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)[^.!?]{0,24}(?:(?:керек|қажет)\s*емес|керегі\s*жоқ|(?<!\p{L})не(?!\p{L})\s*(?:нуж\p{L}*|надо))|(?<!\p{L})не(?!\p{L})\s*(?:нуж\p{L}*|надо)[^.!?]{0,24}(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url))/iu.test(clause);
    if (refusedOrder || refusedLinkRu || refusedLinkKk || refusedLinkNeed) { decision = false; continue; }
    const budgetInquiry = isMenuBudgetInquiry(clause);
    const explicitOrderAction = !budgetInquiry && explicitOrderActionRe.test(clause);
    const explicitLinkRequest = explicitLinkRequestRe.test(clause) || explicitLinkNeedRe.test(clause);
    if (budgetInquiry && !explicitLinkRequest) continue;
    // Writing the menu here grants no checkout permission by itself. A separate
    // current URL or order request can still accompany the textual menu.
    const explicitUrlRequest = explicitLinkNeedRe.test(clause) || explicitLinkRequestRe.test(clause.replace(/(?<!\p{L})(?:меню|мәзір\p{L}*|мазір\p{L}*|каталог\p{L}*|корзин\p{L}*|себет\p{L}*)(?!\p{L})/giu, ""))
      || /(?<!\p{L})(?:скинь|скиньте|скин|скинте)(?!\p{L})\s*(?:мне\s*|нам\s*|пожалуйста\s*){0,2}(?:ссылк\p{L}*|сілтеме\p{L}*|линк|link)(?!\p{L})/iu.test(clause);
    if (wantsMenuAsText(clause) && !explicitUrlRequest
      && !explicitOrderAction && !hasDirectOrderIntent(clause)) {
      decision = false;
      continue;
    }
    const quantityOrPriceQuestion = quantityOrPriceQuestionRe.test(clause);
    const pastLinkStatement = /(?:отправ(?:ил|ила|или|ляли)|присл(?:ал|ала|али)|высл(?:ал|ала|али)|показа(?:л|ла|ли|ывали)|откр(?:ыл|ыла|ыли)|жібер(?:ді|ген|іпті|дім|дің)|жибер(?:ди|ген)|аш(?:тым|тың|ты|қан|ылды)|көрсет(?:ті|тім|тің|кен))/iu.test(clause);
    if ((quantityOrPriceQuestion && !explicitOrderAction && !explicitLinkRequest)
      || (pastLinkStatement && !explicitOrderAction && !explicitLinkRequest)) continue;
    if (explicitLinkRequest || hasDirectOrderIntent(clause)
      || /^(?:меню|мәзір|мазір|каталог|ссылка|сілтеме)[?!.,\s]*$/iu.test(clause.trim())
      || /(?:меню|мәзір|мазір|каталог\p{L}*|корзин\p{L}*|себет\p{L}*|ссылк\p{L}*|сілтеме\p{L}*|линк|link)[^.!?]{0,40}(?:жібер|жибер|қайта|скинь|отправ\p{L}*|пришл\p{L}*|открой\p{L}*|покаж\p{L}*|дай|аш|көрсет|не\s*откры|не\s*работ|ашылмай|қарай|посмотреть)/iu.test(clause)
      || /(?:жібер|жибер|скинь|отправ\p{L}*|пришл\p{L}*|открой\p{L}*|покаж\p{L}*|дай|аш|көрсет|повтор|перешли|қайдан\s*қарай|где\s*посмотреть)[^.!?]{0,40}(?:меню|мәзір|мазір|каталог|корзин|себет|ссылк|сілтеме|линк|link)/iu.test(clause)
      || /(?:хочу\s*(?:(?:сделать|оформить)\s*)?(?:заказ|оформ)|(?:где|как)\s*(?:могу\s*)?(?:оформить|сделать)\s*заказ|заказать|(?:заказ|тапсырыс)\s*(?:бер|берей|берем|жаса|хочу|сдел|оформ)|(?:тапсырысты\s*)?жалғастыр|продолж(?:у|им|ить)\s*(?:заказ|оформ))/iu.test(clause)) decision = true;
  }
  return decision;
}

const ORDER_STATUS_QUESTION_RE =
  /(тапсырысым|заказым|мой\s+заказ|мои\s+заказы|соңғы\s+тапсырыс|последн\p{L}*\s+заказ|order\s+status|тапсырыс.*(?:қайда|кайда|қашан|кашан|дайын|жолда|жеткіз|жеткиз|статус|көрін|корин)|заказ.*(?:где|когда|готов|едет|достав|статус|виден|көрін|корин)|(?:қайда|кайда|қашан|кашан).*(?:тапсырыс|заказ)|(?:где|когда).*(?:заказ|order)|менде.*(?:тапсырыс|заказ).*бар|у\s+меня.*заказ|есть\s+ли.*заказ|статус\s+(?:тапсырыс|заказ|order)|(?:төледім|толедим|оплатил).*(?:тапсырыс|заказ)|(?:тапсырыс|заказ).*(?:төледім|толедим|оплатил))/iu;

const ORDER_NUMBER_RE = /(?:№|#|order\s*|заказ(?:ом|а|у)?\s*|тапсырыс(?:ым|тың|тын)?\s*(?:(?:нөмірі|номері|номер)\s*)?)(\d{1,12})/iu;

const ACTIVE_ORDER_FOLLOW_UP_RE =
  /((?:че|чё|что)\s*там|ну\s*и|и\s*что|не\s*болды|не\s*жаңалық|не\s*жаналык|нестеватсындар|нестеватсыздар|нестеп\s*жатсындар|нестеп\s*жатырсындар|қалай\s*болып\s*жатыр|калай\s*болып\s*жатыр|как\s*там|дайын\s*ба|дайынба|готов(?:о|а)?\s*ли|готов(?:о|а)?|қашан|кашан|когда|скоро\s*ма|скоро|долго\s*(?:ещ[её])?|сколько\s*(?:ещ[её])?|әлі\s*(?:көп\s*пе|қанша\s*күт)|қанша\s*күт|канша\s*кут|жолда\s*ма|жолдама|курьер|едет|келе\s*жатыр\s*ма|келе\s*жатырма|(?:почему|неге)[^.!?]{0,25}(?:не\s*приш|не\s*привез|не\s*достав|келмед|жетпед))/iu;

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
  /(меню|мәзір|мазір|ассортимент|(?<!\p{L})поч[её]м(?!\p{L})|цена|цены|сколько\s*стоит|қанша\s*тұрады|канша\s*турады|канша\s*турад|қанша\s*болады|канша\s*болады|канша\s*болад|қаншадан|каншадан|бағасы|бағасын|багасы|багасын|бар\s*ма|барма|есть\s*ли|что\s*есть|не\s*бар|какие\s*есть|из\s*\p{L}+\s*есть|самый\s*деш[ёе]в|арзан|дешев|скидк|жеңілдік|суши|пицца|ролл|донер|бургер)/iu;

export function hasMenuBrowsingIntent(text = "") {
  return MENU_INTENT_RE.test(String(text || ""));
}

export const MENU_INQUIRY_RE =
  /(?:қайдан\s*(?:қарай|көр|таб)|қарау|көру|көрейін|көрсем|жіберші|сілтеме|ссылк|сайт|меню|мәзір|мазір|баға|прайс|ассортимент|не\s*бар|что\s*есть|каталог|где\s*(?:посмотреть|глянуть)|скинь\s*(?:меню|ссылк))/iu;

export function hasMenuInquiryIntent(text = ""): boolean {
  return intentMatches(MENU_INQUIRY_RE, text);
}

export function isLikelyOrderStatusFollowUp(text = "") {
  const value = String(text || "");
  if (/^\s*(?:№|#)?\s*\d{1,12}\s*[.!?]?\s*$/u.test(value)) return true;
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

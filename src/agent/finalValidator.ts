import {isMenuAttributeVerificationQuestion, customerMenuRelationSubject, menuLexemesRelated} from "../utils/menuQuestionContext.js";
import {shoppingConstraintsForContext, eligibleShoppingItems, isShoppingDecision, shoppingBasketQuote, type ShoppingItem} from "../services/shoppingConstraints.service.js";
import { alignGreetingReply, fallbackReply, readGuestGreeting, stripRoboticOpener } from "./greeting.js";
import {classifyKitchenSalesPolicyForContext, detectKitchenConsentAnswer} from "../services/kitchenPolicy.service.js";
import type { FastFoodContext } from "../context/types.js";
import { getMenuBudgetInquiry, isMenuBudgetInquiry, isQualitativeMenuBudgetInquiry } from "../utils/menuBudget.js";
import { activeOrderQuestionKind, isCustomerOrderStatusQuestion, isLikelyOrderStatusFollowUp } from "../utils/orderIntent.js";
import { complaintHasActionableDetail, isCurrentComplaintRequest, isExplicitCourierContactRequest, isExplicitHumanOperatorRequest, isLikelyComplaintText } from "../services/complaintRouting.service.js";
import { menuItemBlockedByNotes, menuVocabulary } from "../services/noteProvenance.service.js";
import { guardCheckoutSelection, hasCatalogProductMention, hasCatalogSafetyAssertion } from "./checkoutSelectionGuard.js";

// Only an unverified CONCRETE duration is a factual violation. The old pattern
// also matched the bare stem "күт", so every polite "күте тұрыңыз" / "бір минут"
// sentence was deleted whenever wait_time was 0 - which is most of the time.
// That single regex is what made replies read like a stripped-down machine.
const WAIT_TIME_CLAIM_RE =
  /[^.!?\n]*\d{1,3}\s*(?:мин|минут|minute|min|сағат|саг\.|час|часа|часов)[^.!?\n]*[.!?]?/giu;
// Soft signal only: polite waiting language stays in the reply, it is just
// reported in warnings so the audit log still shows it.
const SOFT_WAIT_HINT_RE = /(күте тұр|күтіп тұр|күтіңіз|подожд|ожидай)/iu;
const STALE_WAIT_CONSENT_RE =
  /[^.!?\n]*(?:күте\s+аласыз|күте\s+аласың|күтуге\s+дайын|сможете\s+подождать|готовы\s+(?:подождать|ждать)|будете\s+ждать)[^.!?\n]*[?]?/iu;
const ORDER_STATUS_RE =
  /(тапсырысыңыз|заказыңыз|заказ|order).*(дайындалып|әзірленіп|курьер|жолда|жеткіз|аяқтал|готов|едет|достав|дайын|әзір|даяр)/iu;
// Bare "дайын"/"готов"/"работает" appear in ordinary menu and order replies too,
// so the kitchen guard now demands an explicit kitchen subject next to the
// claim. Otherwise a correct answer got replaced by the canned kitchen line.
const KITCHEN_STATUS_RE =
  /(асүй|ас\s?үй|асхан\p{L}*|кухн\p{L}*|kitchen)[^.!?\n]{0,40}?(дайын|әзір|жұмыс|ашық|жабық|бос|істе|готов|работа|открыт|закрыт|загружен|busy|closed|open)/iu;
const KAZAKH_SPECIFIC_RE = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/u;
// JavaScript's \\b is ASCII-based and misses Cyrillic boundaries, so the old
// detector silently accepted a fully Russian answer in a Kazakh conversation.
const RUSSIAN_SERVICE_WORD_RE =
  /(?:^|[^\p{L}])(вы|ваш|ваша|можете|пожалуйста|заказ|меню|ссылка|оплата|доставка|сейчас|если|для|через|оператор|админ|к сожалению|хотите)(?=$|[^\p{L}])/iu;
const FORBIDDEN_FOREIGN_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bengali}\p{Script=Devanagari}\p{Script=Thai}]/u;
const MENU_LINK_SENT_RE =
  /(алдыңғы сілтеме|предыдущ ссылк|ескі сілтеме|стара ссылка)/iu;
// Hallucination guards. A price or promo the model "remembers" is the single
// most damaging lie a food bot can tell, so such claims may only survive when
// a live tool grounded them this turn. Clause-cut, never reply-replace.
const PRICE_CLAIM_RE =
  /[^.!?\n]*\d[\d\s]*(?:тенге|теңге|тг|₸|kzt)[^.!?\n]*[.!?]?/iu;
const PROMO_CLAIM_RE =
  /[^.!?\n]*(?:скидк|жеңілді|акци|бонус|промо|подарок|сыйлық|тегін|бесплатн)[^.!?\n]*(?:\d|%|бар|есть|жүріп|идет|действу|береміз|даём)[^.!?\n]*[.!?]?|[^.!?\n]*\d[^.!?\n]{0,12}%[^.!?\n]{0,30}(?:скидк|жеңілді|акци|бонус|промо)[^.!?\n]*[.!?]?/iu;
// "Бұл тағамдардың құрамында теңіз өнімдері мен жаңғақтар жоқ" was sent to a
// guest asking for allergen-free food for a child, with no dish named and no
// tool called (live round, 2026-08-12). Telling someone an allergen is absent is
// the one lie that can put them in hospital, so it may only survive when a menu
// lookup grounded it this turn.
// Order-independent on purpose. The first version required the allergen word BEFORE the
// negation, which fits Kazakh ("жаңғақ жоқ") and misses Russian, where the negation comes
// first: "В этом блюде НЕТ ОРЕХОВ" - the single most idiomatic way to answer an allergy
// question - passed the gate untouched while "орехов нет" was cut (found 2026-08-22).
// Also covers the adjective forms ("безглютеновое") and the reassurance form ("безопасно
// для аллергии"), neither of which pairs a term with a separate negation word at all.
const ALLERGEN_TERM = "(?:аллерг|глютен|лактоз|жаңғақ|жангак|орех|арахис|яйц|яиц|жұмыртқа|молок|сүт|кунжут|күнжіт|соев|соя|теңіз\\s*өнім|тениз\\s*оним|морепродукт|құрам|курам|состав)";
const ALLERGEN_NEGATION = "(?:жоқ|жок|болмайды|таза|емес|нет|отсутств|без\\s|бeз\\s|не\\s+содерж|свободн|безопас(?:н|ен)|қауіпсіз|кауипсиз)";
const FOOD_SAFETY_ASSURANCE_RE = /(?:блюд|тағам|аллерг|орех|жаңғақ)[^.!?]*(?:безопас(?:н|ен)|қауіпсіз)|(?:безопас(?:н|ен)|қауіпсіз)[^.!?]*(?:блюд|тағам|аллерг|орех|жаңғақ)/iu;
const ALLERGEN_ASSURANCE_RE = new RegExp(
  "[^.!?\\n]*(?:"
    // term ... negation  ("орехов нет", "жаңғақ жоқ", "состав без ...")
    + `${ALLERGEN_TERM}[^.!?\\n]*${ALLERGEN_NEGATION}`
    // negation ... term  ("нет орехов", "не содержит глютена", "безопасно для аллергии")
    + `|${ALLERGEN_NEGATION}[^.!?\\n]*${ALLERGEN_TERM}`
    // single-word assurances that carry no separate negation
    + "|без(?:глютен|лактоз|молочн|ореховы)\\p{L}*"
    // Kazakh privative suffix: «жаңғақсыз» is «жаңғақ жоқ» in one word
    + "|(?:жаңғақ|жангак|глютен|лактоз)с[ыі]з\\p{L}*"
    + ")[^.!?\\n]*[.!?]?",
  "iu"
);
// What is left after a clause is cut must still be an answer. A surviving
// sentence that points at a list which was just removed ("these dishes...",
// "вот варианты") reads as an answer while naming nothing at all.
const DANGLING_REFERENCE_RE =
  /^[^.!?\n]*(?:бұл\s+(?:тағам|блюд|нұсқа|вариант)|осы\s+тағам|мына\s+тағам|эт(?:и|от|о)\s+(?:блюд|вариант|позици)|вот\s+(?:вариант|что|блюд)|келес[іi]\s+тағам|следующ\p{L}*\s+блюд)[^.!?\n]*[.!?]?$/iu;
const PRICE_GROUNDING_TOOLS = ["searchMenu", "checkOrderStatus", "getPaymentDetails"];
// An allergen statement is a claim about what is IN a dish, so only a menu read can
// ground it. It used to share PRICE_GROUNDING_TOOLS, which meant a turn where the model
// merely checked the order status or asked for the payment requisites was allowed to
// ship "в этом блюде нет орехов" - a hospital-grade lie grounded by a tool that never
// looked at food (found 2026-08-22, reproduced: the sentence survived with
// toolsCalled=["checkOrderStatus"] and again with ["getPaymentDetails"]).
const ALLERGEN_GROUNDING_TOOLS = ["searchMenu"];
// A claim about the WHOLE menu, which no tool can ever ground.
//
// Live QA R7-04.2, 2026-08-24: a guest wrote "у меня аллергия на орехи" and was answered
// "Все блюда в нашем меню не содержат орехов. Можете смело выбирать любое." searchMenu HAD
// run, so the allergen gate below was satisfied - but a composition string listing rice and
// salmon does not state what a dish is free of, and it says nothing at all about the other
// eleven dishes. Blanket permission over an entire menu is the most dangerous form this lie
// takes, and it is exactly the form a helpful model reaches for. No tool call can make it
// true, so it is cut whether or not the menu was read.
const BLANKET_ALLERGEN_ASSURANCE_RE =
  /[^.!?\n]*(?:бар(?:лық|лик)\s+тағам|бүкіл\s+мәзір|мәзірдегі\s+бар\p{L}*|кез\s*келген\s+тағам|все\s+блюда|всё\s+меню|все\s+меню|любое\s+блюдо|люб\p{L}*\s+из\s+меню|в\s+нашем\s+меню)[^.!?\n]*(?:аллерг|глютен|лактоз|жаңғақ|жангак|орех|арахис|яйц|яиц|жұмыртқа|молок|сүт|кунжут|күнжіт|соев|соя|теңіз\s*өнім|морепродукт)[^.!?\n]*[.!?]?|[^.!?\n]*(?:аллерг|глютен|лактоз|жаңғақ|жангак|орех|арахис|яйц|яиц|жұмыртқа|молок|сүт|кунжут|күнжіт|соев|соя|теңіз\s*өнім|морепродукт)[^.!?\n]*(?:бар(?:лық|лик)\s+тағам|бүкіл\s+мәзір|кез\s*келген\s+тағам|все\s+блюда|всё\s+меню|все\s+меню|любое\s+блюдо)[^.!?\n]*[.!?]?|[^.!?\n]*(?:смело\s+выбир\p{L}*|смело\s+заказ\p{L}*|батыл\s+таңда\p{L}*|қорықпай\s+таңда\p{L}*|қорықпай\s+ала\p{L}*)[^.!?\n]*[.!?]?/giu;
// A promotion is not in the menu snapshot and not in any tool result either. The only
// live source for "today there is 20% off" is what the operator wrote in the shift
// notes, so that is what grounds it. Sharing the price gate meant any tenant with a
// preloaded menu - which is every healthy tenant - had the promo guard switched off for
// the whole turn, and an invented discount shipped to the guest (found 2026-08-22).
const PROMO_NOTE_RE = /(скидк|жеңілді|женилди|акци|бонус|промо|подарок|сыйлық|сыйлык|тегін|тегин|бесплатн)/iu;
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function trimUrlPunctuation(url: string) {
  return String(url || "").trim().replace(/[.,!?;:]+$/g, "");
}

function uniqueUrls(text: string): string[] {
  return Array.from(new Set((String(text || "").match(URL_RE) || []).map(trimUrlPunctuation).filter(Boolean)));
}

// A dot between digits is a decimal ("Coca-Cola 0.5л"), not a sentence end. Splitting
// there turned "0.5л" into "0. 5л" after any clause surgery, and the length cap counted
// every volume as a sentence and cut the reply at "Fanta 0." (audit sim 2026-10-04).
const SENTENCE_RE = /(?:[^.!?\n]|\.(?=\d))+[.!?]*/g;
const TERMINATED_SENTENCE_RE = /(?:[^.!?]|\.(?=\d))*[.!?]+(?!\d)/g;

function textWithoutUrls(text: string): string {
  return String(text || "").replace(URL_RE, " ").replace(/\s{2,}/g, " ").trim();
}

function sentenceCount(text: string): number {
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return 0;
  const sentences = trimmed.match(TERMINATED_SENTENCE_RE);
  return sentences ? sentences.length : 1;
}

/**
 * Removes only the sentences that make an unverifiable claim and keeps the rest
 * of the reply intact. URLs are preserved, because a stripped clause must never
 * cost the customer the link they asked for.
 */
function dropSentencesMatching(text: string, pattern: RegExp): string {
  return dropSentencesMatchingUnless(text, pattern, null);
}

/**
 * Same clause surgery, with an escape hatch for sentences that carry their own proof.
 *
 * A guard that can only delete has one failure mode: when the fact IS verified, the
 * verified sentence dies with the invented ones. The promo guard hit exactly that - the
 * storefront runs real discounts (a crossed-out old price on the dish) and every sentence
 * naming one was cut, so a guest asking "акциялар бар ма?" was answered "I cannot say"
 * about a promotion the site was advertising (found 2026-08-24).
 */
function dropSentencesMatchingUnless(
  text: string,
  pattern: RegExp,
  keepIf: ((sentence: string) => boolean) | null
): string {
  const urls = uniqueUrls(text);
  const body = textWithoutUrls(text);
  const sentences = body.match(SENTENCE_RE) || [body];
  const kept = sentences
    .map((sentence) => sentence.trim())
    .filter((sentence) => {
      if (!sentence) return false;
      if (keepIf && keepIf(sentence)) return true;
      return !new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(sentence);
    });
  const rebuilt = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  if (!rebuilt) return "";
  return urls.length ? `${rebuilt}\n${urls.join("\n")}` : rebuilt;
}

const ACCEPTED_ORDER_CLAIM_RE = /(?:заказ[^.!?]{0,50}(?:принят|подтвержд[её]н|оформлен)|тапсырыс(?:ыңыз|ы|ты|тың)?(?!\p{L})[^.!?]{0,50}(?:қабылдан|расталды|рәсімделді))/iu;
const OPERATOR_NOTIFICATION_CLAIM_RE = /(?:оператор|администратор|әкімш)[^.!?]{0,60}(?:уведомл|извещ[её]н|хабардар|хабарлан|передал|отправил|сообщил)|(?:передал|отправил|сообщил)[^.!?]{0,60}(?:оператор|администратор|әкімш)/iu;
const CONFIRMED_OPERATOR_NOTIFICATION_RE = /(?:оператор|администратор|әкімш)[^.!?]{0,60}(?:уведомл|извещ[её]н|хабардар|хабарлан)/iu;
const CONFIRMED_HUMAN_CONTACT_RE = /(?:оператор|администратор|админ|әкімш|экімш)[^.!?]{0,70}(?:хабарластық|хабарластым|хабарладық|хабарладым|хабар бердім|хабар бердік|байланыстық|байланыстым|уведомил|уведомили|сообщил|сообщили|связался|связались)|(?:хабарластық|хабарластым|хабарладық|хабарладым|хабар бердім|хабар бердік|байланыстық|байланыстым|уведомил|уведомили|сообщил|сообщили|связался|связались)[^.!?]{0,70}(?:оператор|администратор|админ|әкімш|экімш)/iu;
const MANUAL_ORDER_WRITE_CLAIM_RE = /(?:(?:я|мы)\s+(?:уже\s+)?(?:оформил|оформляем|оформлю|принял|приняли|принимаю(?!\p{L})|подтверждаю|подтвердил)[^.!?]{0,60}заказ|заказ[^.!?]{0,60}(?:оформил|оформлю|принимаю(?!\p{L})|подтверждаю)|тапсырыс[^.!?]{0,60}(?:рәсімдедім|рәсімдеймін|қабылдадым|қабылдадық|қабылдай\s+аламыз))/iu;
export interface ToolGroundingFindings {
  orderPaymentStatus?: string|null;
  orderFulfillmentType?: string|null;
  orderFound?: boolean;
  orderLookup?: string;
  orderStatus?: string;
  orderStage?: string;
  orderStatusLabel?: string;
  orderItems?: Array<{ name: string }>;
  escalationCreated?: boolean;
  escalationNotificationAccepted?: boolean;
}

function customerProductReadyClaim(sentence: string, ctx: FastFoodContext) {
  return namedMenuItems(ctx, sentence).length > 0
    && (/(?:ваш[аи]?\s+[^.!?]{1,60}|\p{L}+(?:ңыз|ңіз)\s+)(?:готов[аоы]?|дайын)(?=$|[^\p{L}])/iu.test(sentence)
      || /(?:будет\s+готов[ао]?|дайын\s+болады)[^.!?]{0,60}(?:когда|как\s+только|после|рәсімдеген|тапсырыс\s+берген)/iu.test(sentence));
}

function orderStateClaimMatches(sentence: string, evidence: any, ctx: FastFoodContext): boolean | null {
  const productReady = customerProductReadyClaim(sentence, ctx);
  if (!/(?:заказ|тапсырыс|order)/iu.test(sentence) && !productReady) return null;
  const status = String(evidence?.orderStatus ?? evidence?.status ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  const stage = String(evidence?.orderStage ?? evidence?.stage ?? "").toLowerCase().trim();
  const active = !["cancelled", "canceled", "unknown", ""].includes(status)
    && !["cancelled"].includes(stage);
  if (/(?:доставлен|заверш[её]н|аяқтал|жеткізілді)/iu.test(sentence)) return active && (stage === "completed" || status === "completed");
  if (/(?:в\s+процессе\s+приготовления|на\s+стадии\s+приготовления|готовится|готовим|дайындалып|әзірленіп|әзірленуде|дайындалуда)/iu.test(sentence)) return active && (stage === "preparing" || ["paid", "preparing", "cooking"].includes(status));
  if (/(?:готов[аоы]?(?=$|[^\p{L}])|дайын(?=$|[^\p{L}]))/iu.test(sentence)) {
    const orderedItems = Array.isArray(evidence?.orderItems || evidence?.items) ? (evidence.orderItems || evidence.items) : [];
    const productFound = !productReady || namedMenuItems(ctx, sentence).every((item) =>
      orderedItems.some((ordered: any) => menuClaimKey(ordered.name) === menuClaimKey(item.name)));
    return active && (["ready", "prepared"].includes(status) || stage === "ready") && productFound;
  }
  if (/(?:курьер|едет|жолда|в\s+пути)/iu.test(sentence)) return active && (stage === "delivery" || status === "delivery");
  if (ACCEPTED_ORDER_CLAIM_RE.test(sentence)) {
    if (/(?:оформлен|рәсімделді)/iu.test(sentence)) return active;
    return active && (["confirmed", "accepted", "paid", "preparing", "cooking", "ready", "prepared", "delivery", "completed"].includes(status)
      || ["awaiting_receipt", "receipt_review", "preparing", "delivery", "completed"].includes(stage));
  }
  return null;
}

const ACTION_NOT_DONE_RE = /(?:не\s+(?:получил|получили|получено)\s+подтвержден\p{L}*|(?:нет|не\s+было)\s+подтвержден\p{L}*|не\s+могу\s+подтвердить|не\s+(?:принят|подтвержд|оформлен|оформил|готов|уведомл|извещ|передал|отправил|сообщил)|(?:қабылдан|хабарлан|хабардар|дайын)[^.!?]{0,15}(?:жоқ|емес))/iu;

function actionAssertionClauses(sentence:string):string[] {
  // Protect only grammatical complements of an uncertainty governor. Keep
  // original commas in surviving clauses; an independent action remains split.
  const governedCommas=new Set<number>();
  for(const match of sentence.matchAll(/(?:о\s+том|подтвердить|подтвержден\p{L}*),\s*(?=что(?!\p{L})|когда(?!\p{L})|(?:\p{L}+\s+){1,3}ли(?!\p{L}))/giu))
    governedCommas.add(match.index!+match[0].indexOf(","));
  for(const match of sentence.matchAll(/,\s*(?:кажется|похоже|вероятно|возможно)\s*,/giu)){
    governedCommas.add(match.index!);governedCommas.add(match.index!+match[0].lastIndexOf(","));
  }
  const clauses:string[]=[];let start=0;
  for(const match of sentence.matchAll(/,(?!\s*(?:когда|как\s+только|после)(?!\p{L}))|;|\s+(?:но|бірақ|однако|зато|а)\s+/giu)){
    if(match[0]===","&&governedCommas.has(match.index!))continue;
    clauses.push(sentence.slice(start,match.index));start=match.index!+match[0].length;
  }
  clauses.push(sentence.slice(start));
  return clauses.flatMap(clause=>{
    const governed=ACTION_NOT_DONE_RE.test(clause)
      && /(?:подтвержден\p{L}*|подтвердить)\s*,?\s+(?:о\s+том,?\s+)?что(?!\p{L})/iu.test(clause);
    return governed?[clause]:clause.split(/\s+(?:и|және)\s+(?=(?:(?:оператор|администратор|админ|әкімш\p{L}*)(?!\p{L})|(?:плат[её]жный\s+)?чек\p{L}*|(?:төлем\s+)?чек\p{L}*|түбіртек\p{L}*))/iu);
  });
}
function isActionAssertion(value: string, pattern: RegExp | ((sentence: string) => boolean), ctx?: FastFoodContext) {
  const unquoted = value.replace(/«([^»]*)»|“([^”]*)”|"([^"]*)"/gu, (_whole,a,b,c) => {
    const inner=String(a??b??c??"");
    // A literal verified SKU is a subject; a quoted whole claim is not.
    return ctx && namedMenuItems(ctx,inner).some(item=>priceItemKey(item.name)===priceItemKey(inner))?inner:"";
  });
  return (unquoted.match(SENTENCE_RE) || [unquoted])
    .flatMap(actionAssertionClauses)
    .some((clause) => (typeof pattern === "function" ? pattern(clause) : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(clause))
      && !ACTION_NOT_DONE_RE.test(clause));
}

function removeUnsupportedActionClauses(text:string,unsupported:(clause:string)=>boolean):string {
 return (text.match(SENTENCE_RE)||[text]).flatMap(sentence=>
   actionAssertionClauses(sentence)
   .filter(clause=>!unsupported(clause)).map(clause=>clause.trim().replace(/[,;]\s*$/u,""))
 ).join(" ").trim();
}
function menuClaimKey(value: unknown) {
  return String(value || "").toLowerCase()
    .replace(/(?:coca[-\s]*cola|кока[-\s]*кол[ауые]|(?<!\p{L})кол[ауые](?!\p{L}))/gu, "кола")
    .replace(/\s+\d+(?:[.,]\d+)?\s*(?:л|l|мл|ml)\s*$/iu, "")
    .replace(/\s+/g, " ").trim();
}

function namedMenuItems(ctx: FastFoodContext, value: string): any[] {
 return [...new Set(priceItemSpans(ctx,value).map(span=>span.item))];
}
function priceItemKey(value:unknown) {
 return String(value||"").toLowerCase().replace(/ё/g,"е")
  .replace(/(?:coca[-\s]*cola|кока[-\s]*кол[ауые]|(?<!\p{L})кол[ауые](?!\p{L}))/gu,"кола").replace(/\s+/g," ").trim();
}
/** Bounded grammatical endings; never arbitrary substring/stem containment. */
function menuWordPattern(word:string):string {
 const escape=(s:string)=>s.replace(/[.*+?^$(){}|[\]\\]/g,"\\$&");
 const exact=escape(word);
 const cases="(?:сының|сінің|ның|нің|дың|дің|тың|тің|ға|ге|қа|ке|да|де|та|те|дан|ден|тан|тен|ды|ді|ты|ті|мен|пен|бен|ңыз|ңіз|ыңыз|іңіз|а|у|ом|е|ы)?";
 if(word.length<4||/\d/u.test(word))return exact;
 if(/ая$/u.test(word))return escape(word.slice(0,-2))+"(?:ая|ой|ую)";
 if(/[ая]$/u.test(word))return "(?:"+exact+cases+"|"+escape(word.slice(0,-1))+(word.endsWith("а")?"(?:у|ы|е|ой|ою)":"(?:ю|и|е|ей)")+")";
 return exact+cases;
}
function priceItemSpans(ctx:FastFoodContext,value:string):Array<{item:ShoppingItem;start:number;end:number}> {
 const text=priceItemKey(value),spans:Array<{item:ShoppingItem;start:number;end:number}>=[];
 const items=[...(ctx.menuSnapshot?.items||[])].sort((a:any,b:any)=>priceItemKey(b.name).length-priceItemKey(a.name).length);
 for(const item of items){
  const key=priceItemKey(item.name);if(!key)continue;
  const pattern=new RegExp("(?<![\\p{L}\\p{N}])"+key.split(/\s+/u).map(menuWordPattern).join("\\s+")+"(?![\\p{L}\\p{N}])","giu");
  for(const match of text.matchAll(pattern)){
   const start=match.index!,end=start+match[0].length;
   if(spans.some(s=>start<s.end&&end>s.start&&(start!==s.start||end!==s.end)))continue;
   spans.push({item,start,end});
  }
 }
 return spans.sort((a,b)=>a.start-b.start||b.end-a.end);
}
function priceSubjects(ctx:FastFoodContext,prefix:string){
  const normalized=priceItemKey(prefix);
  const composition=normalized.search(/(?:входит|содержит|состав|ингредиент|құрам)/iu);
   const spans=priceItemSpans(ctx,prefix).filter(hit=>composition<0||hit.start<composition);
   const first=spans[0];
   // An explicit title — verified composition — price stays bound to that title,
   // rather than a repeated constituent product inside its composition.
   if(first){
     const description=normalized.slice(first.end).match(/^\s*[-—–:]\s*([\s\S]+?)\s*[-—–:]\s*$/u);
     const words=description?.[1].match(/\p{L}+/gu)?.filter(word=>!/^(?:и|мен|пен|және|с|со)$/iu.test(word)).map(ingredientKey)||[];
     const known=String(first.item.composition||first.item.ingredients||"").toLowerCase().match(/\p{L}+/gu)?.map(ingredientKey)||[];
     if(words.length&&words.every(word=>known.includes(word)))return spans.filter(hit=>hit.start===first.start).map(hit=>hit.item);
   }
   const latest=spans.at(-1)?.start;return spans.filter(hit=>hit.start===latest).map(hit=>hit.item);
}
function menuSentencePricesMatch(sentence: string, ctx: FastFoodContext, antecedent:ShoppingItem[]=[]):boolean {
  const amounts=[...sentence.matchAll(/(\d[\d \u00a0]*(?:[.,]\d+)?)\s*(?:₸|тг|тенге|теңге|kzt)/giu)];
   let previousEnd=0;
   let previousPrice:{item:ShoppingItem;amount:number}|null=null;
   return amounts.every(match=>{
     const prefix=sentence.slice(previousEnd,match.index);previousEnd=match.index!+match[0].length;
     const amount=Number(match[1].replace(/[ \u00a0]/g,"").replace(",","."));
    const named=priceSubjects(ctx,prefix);
    // A guest's stated budget is not a price for an unnamed menu SKU.
    const budgetSubject=/(?:у\s+вас|у\s+меня|вашим|ваш\p{L}*|сенде|сізде|бюджет\p{L}*|шегінде)/giu;
     const budgetAt=[...prefix.matchAll(budgetSubject)].at(-1)?.index??-1;
     const namedAt=priceItemSpans(ctx,prefix).at(-1)?.start??-1;
      const ceilingAfter=/^\s*(?:шегінде|ше[кг]пен|бюджет\p{L}*|(?:это\s+)?(?:мой|ваш)\s+бюджет)(?!\p{L})/iu.test(sentence.slice(previousEnd));
      if(shoppingConstraintsForContext(ctx).budget===amount&&(budgetAt>namedAt||namedAt<0&&ceilingAfter)){
        previousPrice=null;return true;
      }
    const requested=priceItemSpans(ctx,ctx.text).map(hit=>hit.item);
    const anonymous=priceItemKey(prefix).replace(/[^\p{L}]+/gu," ").trim();
    const anonymousPrice=/^(?:(?:цена|стоимость|стоит|он|она|оно|это|этот|эта|данное|блюдо|позиция|за|штуку|бағасы|тұрады|ол|оның|бұл|осы|тағам)\s*)*$/iu.test(anonymous);
    const anaphoric=/^\s*(?:в\s+(?:него|неё|нее)|он[ао]?|его|ее|её|это|цена|стоимость|стоит|құрамында|оның|ол|бағасы|тұрады)(?!\p{L})/iu.test(prefix);
    const oldToCurrent=/^[\s,;:—–-]*(?:орнына|(?:а\s+)?(?:теперь|сейчас)|вместо\s+прежней\s+цены,\s*(?:теперь|сейчас))\s*$/iu.test(prefix);
    const currentToOld=/^[\s,;:—–-]*вместо\s*$/iu.test(prefix);
    const previous=previousPrice as {item:ShoppingItem;amount:number}|null;
    const oldPrice=Number(previous?.item.compare_at_price||previous?.item.old_price);
    const currentPrice=Number(previous?.item.price);
    const comparison=previous && oldPrice>currentPrice
      && (oldToCurrent&&previous.amount===oldPrice&&amount===currentPrice
        || currentToOld&&previous.amount===currentPrice&&amount===oldPrice);
    const candidates=named.length?named:comparison?[previous!.item]:anaphoric&&antecedent.length===1?antecedent:anonymousPrice&&requested.length===1?requested:[];
    const valid=candidates.length===1 && candidates.some(item=>Number(item.price)===amount||(Number(item.compare_at_price||item.old_price)>Number(item.price)&&Number(item.compare_at_price||item.old_price)===amount));
    previousPrice=valid?{item:candidates[0],amount}:null;
    return valid;
  });
}
/** List markers stay attached to their item; other factual guards keep their old sentence policy. */
function validateMenuPriceClaims(text:string,ctx:FastFoodContext):string {
  const urls=uniqueUrls(text);const body=text.replace(URL_RE," ");
  const units=body.split(/\n\s*\n|\n(?=\s*\d+[.)]\s)|(?<=[.!?])\s+(?=\d+[.)]\s)/u);const kept:string[]=[];let nextNumber=1;let removed=false;
  for(const unit of units){
    const marker=unit.match(/^\s*\d+[.)]\s+/u);const content=marker?unit.slice(marker[0].length):unit;
    const sentences=content.match(SENTENCE_RE)||[content];let antecedent:ShoppingItem[]=[];let invalid=false;const output:string[]=[];
    for(const raw of sentences){
      const sentence=raw.trim();if(!sentence)continue;
      const named=priceSubjects(ctx,sentence);
      const good=!new RegExp(PRICE_CLAIM_RE.source,PRICE_CLAIM_RE.flags.replace(/[gy]/g,"")).test(sentence)||menuSentencePricesMatch(sentence,ctx,antecedent);
      if(!good){invalid=true;removed=true;if(!marker&&antecedent.length===1&&output.length&&/(?:рекоменд|посовет|предлага|усына)/iu.test(output.at(-1)||""))output.pop();}
      else output.push(sentence);
      if(named.length)antecedent=named;
    }
    if(marker&&invalid)continue;
    const value=output.join(" ").trim();if(value)kept.push(marker?`${nextNumber++}. ${value}`:value);
  }
  if(!removed)return text;
  const rebuilt=kept.join("\n").trim();return [rebuilt,...urls].filter(Boolean).join("\n");
}

function ingredientKey(word: string) {
  const value = word.toLowerCase();
  const aliases: Array<[RegExp, string]> = [[/^(?:вод|су$)/u, "вода"], [/^(?:сахар|қант|кант)/u, "сахар"],
    [/^(?:куриц|курин|тауық|тауык)/u, "курица"], [/^(?:говяд|сиыр)/u, "говядина"],
    [/^(?:помид|томат|қызанақ)/u, "помидор"], [/^(?:огур|қияр)/u, "огурец"],
    [/^(?:сыр|ірімшік)/u, "сыр"]];
  return aliases.find(([pattern]) => pattern.test(value))?.[1] || value.slice(0, Math.max(3, value.length - 2));
}

function menuCompositionCandidates(sentence: string, ctx: FastFoodContext, claimIndex: number, antecedent: any[] = []): any[] {
  const prefix = sentence.slice(0, claimIndex);
  const named = namedMenuItems(ctx, prefix);
  if (named.length) return named;
  const requested = namedMenuItems(ctx, ctx.text);
  const reference = prefix.replace(/(?:безглютен|безлактоз|орех|жаңғақ|жангак|арахис|яйц|яиц|жұмыртқа|молок|сүт|кунжут|күнжіт|соев|соя|глютен|лактоз)\p{L}*/giu, "")
    .replace(/[^\p{L}]+/gu, " ").trim();
  const anonymous = /^(?:(?:в|у|этом|этой|этого|блюде|блюда|оно|он|она|его|её|состав|составе|это|данном|оның|онда|бұл|осы|тағам|тағамда|тағамның|құрамында|құрамы|ол)\s*)*$/iu.test(reference);
   if (anonymous) return antecedent.length ? (antecedent.length === 1 ? antecedent : []) : requested.length === 1 ? requested : [];
   if (requested.length !== 1) return [];
  // A translated adjective/case can accompany the exact item requested this
  // turn. Resolve only its supported subject words; never use this for prices.
  const titleWords = priceItemKey(requested[0].name).match(/[\p{L}\p{N}]+/gu) || [];
  const titlePatterns = titleWords.map((word) => {
    let pattern = menuWordPattern(word);
    if (/ный$/u.test(word) && word.length > 5) {
      const stem = word.slice(0, -3).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
      pattern += "|" + stem + "(?:ты|ті|ды|ді)";
    }
    return new RegExp("^(?:" + pattern + ")$", "iu");
  });
  const subjectWords = reference.match(/\p{L}+/gu) || [];
  const filler = /^(?:в|у|этом|этой|этого|блюде|блюда|оно|он|она|его|её|состав|составе|это|данном|оның|онда|бұл|осы|тағам|тағамда|тағамның|құрамында|құрамы|ол)$/iu;
  const matchesTitle = (word: string) => titlePatterns.some(pattern => pattern.test(word));
  return subjectWords.some(matchesTitle)
    && subjectWords.every(word => filler.test(word) || matchesTitle(word)) ? requested : [];
}

function hasCurrentCompositionCatalog(ctx:FastFoodContext):boolean {
 const snapshot=ctx.menuSnapshot,menu=ctx.menuGrounding as any;
 // A successful menu tool or preload may populate the snapshot without the optional grounding projection.
 return Boolean((menu||Array.isArray(snapshot?.items)&&snapshot.items.length>0)
   &&menu?.menu_lookup!=="unavailable"&&menu?.stale!==true&&menu?.is_stale!==true
   &&snapshot?.source!=="menu_unavailable"&&!/backup|stale|fallback/u.test(String(snapshot?.source||"")+" "+String(menu?.source||"")));
}
/** Restore only the direct catalog composition; nested component details are not inferred. */
function verifiedCompositionCore(sentence:string,ctx:FastFoodContext,antecedent:any[]):string|null {
 if(!/(?:состав|құрам)/iu.test(ctx.text)||ALLERGY_TOPIC_RE.test(ctx.text)||!hasCurrentCompositionCatalog(ctx))return null;
 const claim=/(?:содержит|в\s+составе\s*[:—-]?|состав\s*:|құрамында|құрамы\s*[:—-])\s+/iu.exec(sentence);
 if(!claim)return null;
 const candidates=menuCompositionCandidates(sentence,ctx,claim.index,antecedent);
 const requested=namedMenuItems(ctx,ctx.text);
 if(candidates.length!==1||requested.length>1||requested.length===1&&requested[0]!==candidates[0])return null;
 const item=candidates[0],composition=String(item.composition||item.ingredients||"").trim();
 if(!composition||composition.length>500)return null;
 return String(item.name)+(ctx.language==="kk"?" — құрамы: ":" — состав: ")+composition.replace(/[.!?]\s*$/u,"")+".";
}
function menuSupportsIngredientClaim(sentence: string, ctx: FastFoodContext, antecedent: any[] = []) {
  if (isCompositionUncertaintyOnly(sentence)) return true;
  const claim = /(?:содержит|в\s+составе\s*[:—-]?|состав\s*:|құрамында|құрамы\s*[:—-])\s+([^.!?]+)/iu.exec(sentence);
  if (!claim || /(?:не\s*содержит|нет|жоқ|емес)/iu.test(sentence)) return true;
  if (!hasCurrentCompositionCatalog(ctx)) return false;
  const candidates = menuCompositionCandidates(sentence, ctx, claim.index, antecedent);
  const claimed = (claim[1].match(/\p{L}+/gu) || []).filter((word) => !/^(?:и|с|со|в|және|пен|мен|бар|қосылған)$/iu.test(word)).map(ingredientKey);
  return Boolean(candidates.length && claimed.length && candidates.every((item) => {
    const known = (String(item.composition || item.ingredients || "").match(/\p{L}+/gu) || []).map(ingredientKey);
    return claimed.every((word) => known.includes(word));
  }));
}

/** A composition pronoun can inherit a verified subject only in this same unit. */
function validateMenuCompositionClaims(text:string,ctx:FastFoodContext):string {
 const units=text.split(/\n\s*\n|\n(?=\s*\d+[.)]\s)/u);let removed=false;
 const kept=units.flatMap(unit=>{
   const marker=unit.match(/^\s*\d+[.)]\s+/u);const content=marker?unit.slice(marker[0].length):unit;
   let antecedent:any[]=[];let invalid=false;
   const output=(content.match(SENTENCE_RE)||[content]).flatMap(sentence=>{
      const good=menuSupportsIngredientClaim(sentence,ctx,antecedent);
      if(!good){
        removed=true;
        const core=verifiedCompositionCore(sentence,ctx,antecedent);
        if(!core){invalid=true;return [];}
        antecedent=priceSubjects(ctx,core);return [core];
      }
      const named=priceSubjects(ctx,sentence);
      if(named.length)antecedent=named;
      else if(!/^\s*(?:он[ао]?|его|е[её]|оның|онда|ол|құрам)/iu.test(sentence))antecedent=[];
      return [sentence];
    });
   if(marker&&invalid)return [];
   const value=output.join(" ").trim();return value?[marker?marker[0]+value:value]:[];
 });
 return removed?kept.join("\n").trim():text;
}
const COMPOSITION_UNKNOWN_RE = /(?:нет\s*(?:данных|информац|сведени)|не\s*(?:могу|можем)\s*(?:подтверд|провер)|состав[^.!?]*(?:неизвест|не\s*указ|уточня)|құрам[^.!?]*(?:белгісіз|көрсетілмеген|нақтыла)|растай\s*алмай)/iu;
const ALLERGEN_GROUPS = [/орех|жаңғақ|жангак/iu, /арахис/iu, /глютен/iu, /лактоз/iu,
  /яйц|яиц|жұмыртқа/iu, /молок|сүт/iu, /кунжут|күнжіт/iu, /соев|соя/iu,
  /морепродукт|теңіз\s*өнім|тениз\s*оним/iu];

function isScopedNegatedCompositionClaim(clause: string) {
  const value = clause.replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "").trim();
  // The object precedes the negated verification verb in these honest replies.
  // A positive assertion joined to it must remain subject to the other guards.
  if (/(?<!\p{L})(?:подтвержден[аоы]?|подтверждён[аоы]?|гарантирую|точно|безопасно|расталған)(?!\p{L})/iu.test(value)) return false;
  return /^(?:(?:не\s+говорю|не\s+утверждаю)\s*:\s*)?(?:отсутствие|наличие|безопасность)[^.!?;,]{0,70}(?:гарантировать|подтвердить|проверить)\s+не\s*(?:могу|можем)[.!?]?$/iu.test(value)
    || /^(?:\p{L}+\s+){0,8}(?:жоқ|бар)\s+екен(?:ін|дігін)\s+(?:растай|тексере)\s+алмай\p{L}*[.!?]?$/iu.test(value);
}

const ALLERGY_TOPIC_RE = /аллерг|орех|арахис|жаңғақ|жангак|глютен|лактоз/iu;
const ALLERGY_REASSURANCE_RE = /(?<!\p{L})(?:алаңдама\p{L}*|уайымдама\p{L}*|қорықпа\p{L}*|не\s*(?:беспокой\p{L}*|волнуй\p{L}*|переживай\p{L}*|бой\p{L}*)|ничего\s+страшного)(?!\p{L})/iu;

function unverifiedAllergyReassurance(sentence: string, ctx: FastFoodContext) {
  const plain = sentence.replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  const current = String(ctx.text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  // Only a current food/health continuation carries the nearest customer's
  // allergy context forward. Assistant claims and unrelated payment turns do not.
  const foodContinuation = hasCatalogProductMention(current, ctx) || /(?:блюд|ед[ауы]|пищ|донер|тағам|тамақ|тамак|жеуге|жесе|бере\s+ал|беруге)/iu.test(current)
    || /(?:можно|может|могу|дать|давать)[^.!?]{0,35}(?:ему|ей|реб[её]нку|есть)|(?:ему|ей)[^.!?]{0,35}(?:дать|давать|есть)/iu.test(current);
  const previousCustomer = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [])
    .slice(-6).filter((row: any) => row?.role === "user")
    .map((row: any) => String(row.content ?? row.text ?? "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, ""))
    .filter((value: string) => value.trim() && value.trim() !== current.trim()).slice(-1)[0] || "";
  if (!ALLERGY_TOPIC_RE.test(current) && !ALLERGY_TOPIC_RE.test(plain)
    && !(foodContinuation && ALLERGY_TOPIC_RE.test(previousCustomer))
    && !(plain.match(SENTENCE_RE) || [plain]).some(sentence => hasCatalogSafetyAssertion(sentence, ctx))) return false;
  // Explicit technical help is empathy about that operation, not health advice.
  if (/(?:помо[гщ]|разобра|көмектес|тексер)[^.!?]{0,35}(?:оплат|ссылк|доставк|төлем|сілтеме|жеткізу)|(?:оплат|ссылк|доставк|төлем|сілтеме|жеткізу)[^.!?]{0,35}(?:помо[гщ]|разобра|көмектес|тексер)/iu.test(plain)
    && !/(?:блюд|пищ|аллерг|орех|жаңғақ|тағам|жеуге|безопас(?:н|ен)|қауіпсіз|смело\s+давать)/iu.test(plain)) return false;
  return (plain.match(SENTENCE_RE) || [plain]).some((sentence) => {
    const honestDenial = isCompositionUncertaintyOnly(sentence);
    // Inspect the complete subject/predicate too: a parenthetic comma must not
    // detach a catalog food from its safety claim. Dependency is sentence-local.
    if (!honestDenial && hasCatalogSafetyAssertion(sentence, ctx)) return true;
    const separateAdditive = !honestDenial
      && /^(?:я\s+)?не\s+(?:могу|можем)\s+(?:подтвердить|гарантировать|проверить)(?=$|[^\p{L}])/iu.test(sentence);
    const independentParts = separateAdditive ? sentence.split(/\s+(?:и|және)\s+/iu) : [sentence];
    const declaredDependency = /^(?:я\s+)?не\s+(?:могу|можем)\s+(?:подтвердить|гарантировать|проверить)\s*,?\s*что(?=$|[^\p{L}])/iu.test(sentence);
    return independentParts.some((part, index) => {
      if (index > 0 && declaredDependency && hasCatalogSafetyAssertion(part, ctx, true)) return false;
      if (!honestDenial && hasCatalogSafetyAssertion(part, ctx)) return true;
      return part.split(/[,;]|\s+[—–-]\s+|\s+(?:но|бірақ|однако|зато)\s+/iu).some((clause) =>
      (ALLERGY_REASSURANCE_RE.test(clause) || /(?:можно\s+смело\s+(?:дать|давать|есть)|еш\s+қауіп\s+жоқ)/iu.test(clause)
        || (!honestDenial && hasCatalogSafetyAssertion(clause, ctx) && !isCompositionUncertaintyOnly(clause)))
        && !/(?:не\s*(?:говорю|говорил|утверждаю)|айтпай\p{L}*|демей\p{L}*)/iu.test(clause)
        && !/(?:не\s*(?:беспокой\p{L}*|волнуй\p{L}*)\s+о\s+(?:ссылк|доставк|оплат)|(?:сілтеме|жеткізу|төлем)[^.!?]{0,15}(?:туралы|жөнінде)\s+алаңдама)/iu.test(clause));
    });
  });
}

function isCompositionUncertaintyOnly(sentence: string) {
  // A coordinated Kazakh complement remains under its final negated verification
  // verb. An independent later or adversative assertion is outside this scope.
  const dependentSafetyDenial = /^(?:[\p{L}-]+\s+){1,5}қауіпсіз\s+екен(?:ін|дігін)(?:\s+және\s+(?:[\p{L}-]+\s+){1,5}қауіпсіз\s+екен(?:ін|дігін)){0,3}\s+(?:растай|тексере)\s+алмай\p{L}*[.!?]?$/iu;
  if (dependentSafetyDenial.test(sentence.trim())
    && !/(?<!\p{L})(?:но|бірақ|однако|зато)(?!\p{L})/iu.test(sentence)) return true;
  // A denial talks ABOUT safety; it must not be mistaken for a safety assertion.
  // Check each adversative/coordinate clause so a later assurance stays prohibited.
  const clauses = sentence.replace(/((?:гарантировать|подтвердить)),\s*что\s+/giu, "$1 что ").split(/[,;]|\s+[—–-]\s+|\s+(?=без\s+гаранти|не\s+означа\p{L}*\s+гаранти)|\s+(?:но|бірақ|однако|зато|и|және)\s+/iu);
  const denial = /^(?:(?:кешіріңіз|извините)[,\s]*)?(?:не\s*(?:могу|можем)\s*(?:гарантировать|подтвердить|проверить)[^.!?;]*|(?:гарантировать|подтвердить|проверить)[^.!?;]*не\s*(?:могу|можем)|[^.!?;]*(?:кепілдік\s*бере\s*алмаймын|қауіпсіздігін\s*растай\s*алмаймын))[.!?]?$/iu;
  const medicalDenial = /^(?:без\s+гаранти(?:и|й)\s+безопасности|не\s+означает\s+гаранти(?:и|й)\s+безопасности)[.!?]?$/iu;
  let uncertainty = false;
  for (const clause of clauses) {
    if (denial.test(clause.trim()) || medicalDenial.test(clause.trim()) || isScopedNegatedCompositionClaim(clause)) { uncertainty = true; continue; }
    if (COMPOSITION_UNKNOWN_RE.test(clause)) {
      uncertainty = true;
      if (!/содержит|құрамында|безопас(?:н|ен)|қауіпсіз|кауипсиз|(?:орех|жаңғақ|арахис|глютен|лактоз)[^.!?]*(?:нет|жоқ|сыз)|нет[^.!?]*(?:орех|жаңғақ|арахис|глютен|лактоз)/iu.test(clause)) continue;
    }
    if (ALLERGEN_ASSURANCE_RE.test(clause) || /содержит|құрамында|безопас(?:н|ен)|қауіпсіз|кауипсиз/iu.test(clause)) return false;
  }
  return uncertainty;
}


function menuSupportsAllergenAbsence(sentence: string, ctx: FastFoodContext) {
  if (isCompositionUncertaintyOnly(sentence)) return true;
  if (/безопас(?:н|ен)|қауіпсіз|кауипсиз/iu.test(sentence)) return false;
  const absence = new RegExp(ALLERGEN_NEGATION, "iu").exec(sentence);
  const candidates = menuCompositionCandidates(sentence, ctx, absence?.index ?? sentence.length);
  const groups = ALLERGEN_GROUPS.filter((group) => group.test(sentence));
  return Boolean(candidates.length && groups.length && candidates.every((item) => {
    const composition = String(item.composition || item.ingredients || "");
    const sourceStatements = composition.match(new RegExp(ALLERGEN_ASSURANCE_RE.source, "giu")) || [];
    return groups.every((group) => sourceStatements.some((statement) => group.test(statement)
      && !/безопас(?:н|ен)|қауіпсіз|кауипсиз/iu.test(statement)));
  }));
}

/**
 * Dishes this restaurant is genuinely discounting right now: the live menu carries a
 * crossed-out old price above the current one. Read from the preloaded snapshot, which is
 * the same catalog searchMenu reads, so a promo sentence naming one of these dishes is a
 * fact and not a guess.
 */
function discountedMenuNames(ctx: FastFoodContext): string[] {
  const items = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot!.items : [];
  return items
    .filter((item: any) => Number(item?.old_price || 0) > Number(item?.price || 0))
    .map((item: any) => String(item?.name || "").trim())
    .filter(Boolean);
}

/**
 * "We only deliver to <the restaurant's own address>."
 *
 * The address getBusinessInfo returns is where the kitchen stands. Nothing in this agent
 * knows the delivery zone - the site decides it at checkout - yet a guest who gave their
 * street was told "Өкінішке орай, біз тек Арман 54 мекенжайына жеткіземіз" and the sale
 * died on an invented boundary (live QA R3-06.1 and R5-07.1, 2026-08-24). A refusal to
 * deliver somewhere is a fact this bot can never hold, so the sentence is cut and the
 * honest one takes its place.
 */
const DELIVERY_ZONE_REFUSAL_RE =
  /[^.!?\n]*(?<!\p{L})(?:тек|только|лишь)(?!\p{L})[^.!?\n]{0,60}(?:жеткіз|жеткиз|достав|доставля)[^.!?\n]*[.!?]?|[^.!?\n]*(?:жеткіз|жеткиз|достав)[^.!?\n]{0,40}(?:мүмкін емес|мумкин емес|алмаймыз|болмайды|не\s+можем|невозможн|не\s+осуществля)[^.!?\n]{0,40}(?:мекенжай|адрес|көше|улиц|аудан|район)[^.!?\n]*[.!?]?|[^.!?\n]*(?:мекенжай|адрес|көше|улиц|аудан|район)[^.!?\n]{0,50}(?:жеткіз\p{L}*\s*(?:мүмкін емес|алмаймыз|болмайды)|не\s+доставля|вне\s+зоны|аймақтан\s+тыс)[^.!?\n]*[.!?]?/giu;

function deliveryZoneUnknownText(language: unknown) {
  return language === "kk"
    ? "Жеткізу мекенжайыңызға шыға ма - оны тапсырыс рәсімдеу кезінде сайттың өзі көрсетеді. Сілтемеден таңдап көріңіз, мекенжайды сол жерде тексереміз."
    : "Доставим ли мы на ваш адрес - это показывает сам сайт при оформлении заказа. Выберите блюда по ссылке, и адрес проверится там же.";
}

// A PAST-TENSE claim that a human was told. Only the escalate tool can make one true, and
// only when its result says action=operator_case_created.
//
// Live QA, 2026-08-24 morning (A50): a guest wrote "Чек жібердім, ақшам қайтып келмейді
// ме?" and was answered "Ақшаңыздың қайтарылуына қатысты мәселені әкімшіге
// хабарластық..." - while NO case existed anywhere: escalateToAdmin was never called, the
// text matched no complaint pattern, so nothing routed, and the panel stayed silent. The
// guest then waited for a human nobody had asked for. This is the escalation mirror of the
// manual-order boundary, and it needs the same treatment: an accomplished-notification
// claim is only allowed when a tool result proves it.
const PAST_ESCALATION_CLAIM_RE =
  /[^.!?\n]*(?:әкімш|экімш|администратор|оператор)[^.!?\n]{0,40}(?:хабарласты(?:қ|м|ң)|хабарладым|жеткіздік|жеткіздім|жібердік|жібердім|растадым|айттым|жолдадым|жолдадық)[^.!?\n]*[.!?]?|[^.!?\n]*(?:хабарластық|жеткіздік|жібердік|жолдадық)[^.!?\n]{0,40}(?:әкімш|экімш|администратор|оператор)[^.!?\n]*[.!?]?/giu;

const FUTURE_HUMAN_ACTION_RE = /(?:позову|подключу|передам|сообщу|отправлю|уточню|уточняю)[^.!?]{0,70}(?:оператор|администратор|кухн)|(?:оператор|администратор)[^.!?]{0,70}(?:ответит|свяжется|подключится)|(?:оператор|әкімш|ас\s*үй|асүй)[^.!?]{0,70}(?:жауап\s*береді|қосылады|хабарласады|хабарлаймын|жіберемін|жеткіземін|нақтылап\s*беремін|нақтылаймын)|(?:хабарлаймын|жіберемін|жеткіземін|нақтылап\s*беремін|нақтылаймын)[^.!?]{0,70}(?:оператор|әкімш|ас\s*үй|асүй)|(?:тезірек|жақын\s*арада)[^.!?]{0,40}жауап[^.!?]{0,20}аласыз|(?:скоро|в\s*ближайшее\s*время)[^.!?]{0,40}(?:получите\s*ответ|вам\s*ответят)/iu;
const FUTURE_HUMAN_CONTACT_RE = /(?:^|[^\p{L}])(?:оператор\p{L}*|администратор\p{L}*|әкімш\p{L}*|они|он|она|олар|ол)(?=$|[^\p{L}])[^.!?]{0,80}(?:ответит|ответят|свяжется|свяжутся|подключится|подключатся|жауап\s*береді|байланысады|хабарласады|қосылады)|(?:с\s+вами|вам|сізбен|сізге)[^.!?]{0,60}(?:свяжется|свяжутся|ответят|байланысады|хабарласады|жауап\s*береді)|(?:человек|сотрудник|служба\s+поддержки|қолдау\s+қызметі)[^.!?]{0,80}(?:ответит|ответят|ответить|свяжется|свяжутся|жауап\s*береді|хабарласады)|(?:ответит|ответят|ответить|свяжется|свяжутся)[^.!?]{0,35}(?:человек|сотрудник|служба\s+поддержки)/iu;
const HUMAN_CONTACT_TIME_RE = /(?:вскоре|скоро|в\s+ближайшее\s+время|сразу|немедленно|жақын\s+арада|жақында|тезірек|\d+\s*(?:минут|мин|сағат))/iu;
const KITCHEN_ACTION_RE = /(?:кухн|ас\s*үй|асүй)[^.!?]{0,70}(?:нақтылап|нақтылай|тексеріп)|(?:уточню|уточняю|спрошу|проверю)[^.!?]{0,70}кухн/iu;
// A conditional offer still asserts the bot can physically check with kitchen
// staff. Catalog lookup and runtime status tools provide no such capability.
const KITCHEN_CHECK_CAPABILITY_RE = /(?:асханадан|ас\s*үйден|асүйден)[^.!?]{0,70}(?:тексеру\s+жасай\s+аламын|тексеру\s+жасауға\s+дайынмын|тексере\s+аламын)|могу\s+(?:уточнить|проверить|спросить)[^.!?]{0,70}(?:на\s+кухне|у\s+повара)/iu;
function promisedHumanAction(sentence: string, pattern: RegExp) {
  const unquoted = pattern === KITCHEN_CHECK_CAPABILITY_RE
    ? sentence.replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "")
    : sentence.replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  return (unquoted.match(SENTENCE_RE)||[unquoted]).flatMap(actionAssertionClauses).some((clause) =>
    pattern.test(clause) && !ACTION_NOT_DONE_RE.test(clause)
      && !/(?:не\s*(?:буду|могу|стану|позову|передам|сообщу|уточню|ответит|свяжется|подключится)|(?:хабарлай|жібер|нақтыла)[^.!?]{0,20}(?:алмай|емес|жоқ))/iu.test(clause)
      && !(pattern !== KITCHEN_CHECK_CAPABILITY_RE && (clause.includes("?")||/^\s*(?:если|егер|қажет\s*болса|керек\s*болса)/iu.test(clause))));
}

function unverifiedHumanActionText(ctx: FastFoodContext, caseCreated: boolean, notificationAccepted: boolean) {
  if (notificationAccepted) return ctx.language === "kk"
    ? "Өтінішіңіз тіркелді. Оператордың жауап беру уақытын әзірге растай алмаймын."
    : "Ваша просьба зарегистрирована. Время ответа оператора пока подтвердить не могу.";
  if (caseCreated) return ctx.language === "kk"
    ? "Өтінішіңіз тіркелді. Операторға хабарламаның жеткізілгенін әзірге растай алмаймын."
    : "Ваша просьба зарегистрирована. Доставку уведомления оператору пока подтвердить не могу.";
  return ctx.language === "kk"
    ? "Оператор әзірге қосылған жоқ. Не болғанын айтып беріңізші."
    : "Оператор пока не подключён. Расскажите, пожалуйста, что случилось.";
}

function operatorPromiseBrokenText(language: unknown) {
  return language === "kk"
    ? "Кешіріңіз, өтінішіңізді операторға жібере алмадым - техникалық ақау болып тұр. Біраздан кейін қайта жазып көріңіз немесе бізге қоңырау шалыңыз."
    : "Извините, я не смог передать вашу просьбу оператору - технический сбой. Напишите чуть позже или позвоните нам.";
}

function enforceMaxSentences(text: string, max = 5): string {
 const urls=uniqueUrls(text),body=String(text || "").replace(URL_RE," ").trim();
 if(!body)return text;
 // A list marker stays attached to its complete item.
 const units=body.split(/\n(?=\s*\d+[.)]\s)|(?<=[.!?])\s+(?=\d+[.)]\s)/u);
 if(!units.some(unit=>/^\s*\d+[.)]\s+/u.test(unit))){
  const parts=[...body.matchAll(TERMINATED_SENTENCE_RE)];
  let count=0,end=0;
  for(const part of parts){
   const next=part.index!+part[0].length;
   if(count>=max||(count>0&&next>600))break;
   end=next;count++;
  }
  // Preserve the original separators of the retained prose prefix.
  const kept=parts.length?body.slice(0,end).trim():body;
  return [kept,...urls].filter(Boolean).join("\n");
 }
 const kept:string[]=[];let count=0,length=0;
 for(const unit of units){
  const numbered=/^\s*\d+[.)]\s+/u.test(unit);
  const parts=numbered?[unit]:(unit.match(TERMINATED_SENTENCE_RE)||[unit]);
  for(const part of parts){const value=part.trim();if(!value)continue;
   if(count>=max||(length&&length+value.length>600))return [...kept,...urls].filter(Boolean).join("\n");
   kept.push(value);count++;length+=value.length;
  }
 }
 return [...kept,...urls].filter(Boolean).join("\n");
}

const TOOL_PROTOCOL_LEAK_RE = /(?:^|\n)\s*(?:type\s*:\s*["']?tool_code["']?|code\s*:\s*["']?\s*(?:print\s*\(\s*)?default_api\.|(?:print\s*\(\s*)?default_api\.|<\/?tool_(?:call|code)\b)[\s\S]*/iu;

function stripToolProtocolArtifacts(text: string) {
  const value = String(text || "");
  if (!TOOL_PROTOCOL_LEAK_RE.test(value)) return { text: value, removed: false };
  return { text: value.replace(TOOL_PROTOCOL_LEAK_RE, "").trim(), removed: true };
}

function stripBotTags(text: string) {
  return String(text || "")
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/gi, (_match, label, url) =>
      [String(label || "").trim(), String(url || "").trim()].filter(Boolean).join("\n")
    )
    .replace(/\[(?:Системный Анализ|System Analysis):[\s\S]*?\]/gi, "")
    .replace(/\[ESCALATE_ADMIN\]/gi, "")
    .replace(/\[ESCALATE_DEVELOPER\]/gi, "")
    .replace(/\[IGNORE_MESSAGE\]/gi, "")
    // A stage direction the model wrote for itself instead of letting the transport do its
    // job. Live QA R7-04.2: a guest asking about nuts was answered "...вот ссылка:
    // [ссылка будет отправлена отдельным сообщением]" - bracketed machinery text shipped to
    // WhatsApp while NO link travelled at all (hasLink was false on that turn). The system
    // appends the real link as its own message when sendMenuLink granted one; a placeholder
    // in prose is always wrong, so any bracketed group that talks about links or messages
    // goes.
    .replace(/\[[^\]\n]*(?:ссылк|сілтем|сылтем|link|хабарлам|сообщени)[^\]\n]*\]/gi, "")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Reasoning the model narrated to itself and then sent to the guest.
//
// The prompt tells the agent to think silently, and a flash model complies by writing the
// thinking down first: three live QA turns shipped replies that literally began "Silent
// Thought: The user is asking about promotions. I should state that I don't have
// information about promotions." followed by the real Kazakh answer (2026-08-24). It is
// English, it exposes the machinery, and it is the single most embarrassing thing this bot
// can send. Every guard in this file already assumed such a preamble could not exist.
//
// Cut only a leading meta-labelled block, and only up to the point where the real answer
// starts, so a reply that merely contains the word "thought" is untouched. The label may
// be followed by a newline or run straight into the answer, which is why the sentence walk
// below stops at the first sentence that is not part of the narration.
const REASONING_PREAMBLE_LABEL_RE =
  /^\s*(?:\(|\[|\*)?\s*(?:silent\s+thought|internal\s+thought|my\s+thought(?:s|\s+process)?|thought\s+process|thinking|reasoning|analysis|chain\s+of\s+thought|scratchpad|internal\s+monologue|ішкі\s+ой|внутренн\p{L}*\s+мысл\p{L}*|размышлени\p{L}*)\s*(?:\)|\])?\s*[:\-–—]\s*/iu;
// The narration is written in English about the customer in the third person. The answer
// itself is always Kazakh or Russian, so the first sentence carrying Cyrillic ends it.
const LATIN_NARRATION_SENTENCE_RE = /^[^\p{Script=Cyrillic}]*$/u;

export function stripReasoningPreamble(text: string): { text: string; removed: boolean } {
  const raw = String(text || "");
  if (!REASONING_PREAMBLE_LABEL_RE.test(raw)) return { text: raw.trim(), removed: false };
  const afterLabel = raw.replace(REASONING_PREAMBLE_LABEL_RE, "");
  // Walk the narration sentence by sentence and stop at the first one that contains
  // Cyrillic - that is the guest-facing answer. `[^.!?]+[.!?]*` keeps the separators.
  const sentences = afterLabel.match(/[^.!?\n]+[.!?]*\n?/g) || [afterLabel];
  let index = 0;
  while (index < sentences.length && LATIN_NARRATION_SENTENCE_RE.test(sentences[index])) index += 1;
  const answer = sentences.slice(index).join("").trim();
  // Never let this guard empty a reply: if the whole message was narration there is no
  // answer to keep, and the caller's own fallback is the honest outcome.
  return { text: answer, removed: true };
}


/** Recover a guest answer only after unmistakable model response planning. */
function stripResponsePlanning(text:string,ctx:FastFoodContext,toolsCalled:string[]):{text:string;removed:boolean} {
 const raw=String(text||"");
 // Quoted customer text is content, not authority to classify the response as planning.
 const visible=raw.replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu,span=>" ".repeat(span.length))
  .replace(/https?:\/\/[^\s<>]+/giu,span=>" ".repeat(span.length));
 const selfPlan=/\b(?:I\s+(?:should|must|will|can|need\s+to)\s+(?:use|call|present|list|state|follow|adhere|write|respond|answer|construct|compose|provide|check)|let['’]s\s+(?:construct|compose|write|answer|respond))\b/iu;
 const machinery=/\b(?:FACTS_CONTEXT|reply_shape|searchMenu|checkOrderStatus|getKitchenStatus|getShiftNotes|sendMenuLink|tool|system\s+prompt)\b/iu;
 if(!selfPlan.test(visible)||!machinery.test(visible))return {text:raw,removed:false};
 // A Cyrillic quote or catalog preview in the planning block is not the answer.
 // Walk past the LAST unquoted Latin narration, including a ".Қазір" boundary.
 let lastNarrationEnd=0;
 for(const match of raw.matchAll(/[^.!?\n]+[.!?]*\n?/gu)){
  const unit=visible.slice(match.index!,match.index!+match[0].length);
  const words=replyProse(unit,ctx).match(/[a-z]{2,}/giu)||[];
  if(words.some(word=>!/^(?:kzt|kg|ml|qr)$/iu.test(word)))lastNarrationEnd=match.index!+match[0].length;
 }
 const tail=raw.slice(lastNarrationEnd).trim();
 const body=textWithoutUrls(tail);
 if(lastNarrationEnd>0&&/[\p{Script=Cyrillic}]/u.test(body)&&/[.!?…][»”")\]]*$/u.test(body)
  &&!selfPlan.test(tail)&&!machinery.test(tail))return {text:tail,removed:true};
 // If separation is uncertain, answer the same request from independently current facts.
 return {text:mixedMenuAvailabilityReply(ctx,toolsCalled)??(ctx.language==="kk"
  ?"Сұрағыңызға нақты жауапты қазір растай алмаймын.":"Сейчас не могу подтвердить ответ на ваш вопрос."),removed:true};
}

// Greeting handling lives in ./greeting.ts (fallback greets; a pure greeting is answered
// in the guest's own form, without robotic stamps).
const fallback = fallbackReply;

function orderStatusUnknownText(ctx: FastFoodContext) {
  return ctx.language === "kk" ? "Тапсырыстың қазіргі күйін растай алмаймын. Тапсырыс нөмірін жазыңызшы."
    : "Не могу сейчас подтвердить состояние заказа. Уточните, пожалуйста, номер заказа.";
}

function noActiveOrderText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Қазір белсенді тапсырысыңыз жоқ."
    : "Сейчас нет активного заказа.";
}


// When the only thing the model had to say about an allergen was unverified, the
// honest reply is that we will check it rather than silence or a generic prompt.
// The promo guard used to warn and then keep the sentence when the invented discount was
// the entire reply, so "Сегодня действует скидка 20%" still reached the guest with only a
// log line to show for it. Every other guard here has a deterministic line to fall back
// to; this one now does too (found 2026-08-22).
function promoUnverifiedText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Қазір қолданыстағы жеңілдік немесе акция туралы нақты дерек жоқ."
    : "Сейчас у меня нет подтверждённых данных о действующих скидках и акциях.";
}

function allergenUnverifiedText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Құрамы мен аллергендері туралы мәліметтің толықтығын және аллергендердің жоқтығын растай алмаймын. Аллергия кезінде қауіпсіз екеніне кепілдік бере алмаймын."
    : "Полноту сведений о составе и аллергенах, а также отсутствие аллергенов подтвердить не могу. Гарантировать безопасность при аллергии не могу.";
}

function allergySafetyGuaranteeRequested(ctx: FastFoodContext) {
  const text = String(ctx.text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  if (!/аллерг|орех|арахис|жаңғақ|жангак|глютен|лактоз/iu.test(text)) return false;
  const request = /гарантиру(?:ете|ешь|й|йте)|(?:можете|можешь|можно|дай|дайте)[^.!?]{0,70}гарант|гарант[^.!?]{0,60}(?:можете|можешь|даёте|даете)|кепілдік[^.!?]{0,35}(?:бере\s*аласыз|бере\s*аласың|бересіз|бар\s*ма)/iu;
  const refusal = /не\s+(?:прошу|требую)\s+гарант\p{L}*|гарант(?:ия|ии|ий|ию|ировать)\s+не\s+(?:нужн\p{L}*|требуется)|не\s+(?:нужно|надо|нужна|нужны)\s+гарант|без\s+гаранти|не\s+гарантиру(?:йте|й)|кепілдік(?:ті)?\s*(?:керек\s*емес|қажет\s*емес|сұрамай\p{L}*|талап\s*етпей\p{L}*|бермеңіз)/iu;
  let requested = false;
  // A refusal concerns the guarantee in its clause. A later explicit request
  // reopens it, while a later guarantee refusal withdraws the earlier request.
  for (const clause of text.split(/[.!?;:,\n]|\s+(?:но|однако|бірақ)\s+/iu)) {
    if (refusal.test(clause)) requested = false;
    else if (request.test(clause)) requested = true;
  }
  return requested;
}

function hasHonestSafetyGuaranteeDenial(text: string) {
  return (text.match(SENTENCE_RE) || [text]).some((sentence) =>
    isCompositionUncertaintyOnly(sentence)
    && /не\s*(?:могу|можем)[^.!?]{0,70}гарант|гарант[^.!?]{0,70}не\s*(?:могу|можем)|кепілдік[^.!?]{0,40}алмай|қауіпсіздігін\s*растай\s*алмай/iu.test(sentence));
}

function safetyGuaranteeDenialText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Аллергия кезінде қауіпсіздігіне кепілдік бере алмаймын."
    : "Гарантировать безопасность при аллергии не могу.";
}

function runtimeUnavailableText(ctx: FastFoodContext) {  return ctx.language === "kk"
    ? "Қазір асүй статусын тексере алмаймын. Кейін қайталап жазыңыз."
    : "Не могу проверить статус кухни. Напишите позже.";
}

function hasLinkInResponse(text: string): boolean {
  return uniqueUrls(text).length > 0;
}

function isLikelyMagicLinkUrl(url: string, magicLink: string): boolean {
  try {
    const magicHost = new URL(magicLink).hostname.replace(/\.+$/g, "").toLowerCase();
    const host = new URL(url).hostname.replace(/\.+$/g, "").toLowerCase();
    return host === magicHost || magicHost.startsWith(`${host}.`) || host === magicHost.split(".")[0];
  } catch {
    try {
      const magicHost = new URL(magicLink).hostname.replace(/\.+$/g, "").toLowerCase();
      const firstLabel = magicHost.split(".")[0];
      const lowerUrl = url.toLowerCase();
      return lowerUrl.startsWith(`http://${firstLabel}`) || lowerUrl.startsWith(`https://${firstLabel}`);
    } catch {
      return false;
    }
  }
}

function enforceExactMagicLink(text: string, ctx: FastFoodContext): string {
  if (!ctx.magicLink || !hasLinkInResponse(text)) return text;
  return String(text || "").replace(URL_RE, (url) => {
    const cleanUrl = trimUrlPunctuation(url);
    return isLikelyMagicLinkUrl(cleanUrl, ctx.magicLink || "") ? ctx.magicLink || cleanUrl : cleanUrl;
  });
}

// sendMenuLink grants the exact URL and its one-month validity. Its result
// contains no country-wide scope; delivery facts and a customer's address do
// not extend that link contract. Remove only the unsupported geographic
// modifier from an asserted link-validity clause, keeping duration and content.
function stripUnsupportedLinkGeography(text: string, ctx: FastFoodContext): string {
  if (ctx.magicLinkGranted !== true || !ctx.magicLink) return text;
  const countryScope = /(?:Қазақстан\s+бойынша|по\s+всему\s+Казахстану|на\s+всей\s+территории\s+Казахстана)/giu;
  const linkSubject = /(?:сілтеме\p{L}*|ссылк\p{L}*|link|https?:\/\/)/iu;
  const validity = /(?:жарамды|жарамдылық|действител\p{L}*|действует|работает)/iu;
  let linkMentioned = false;
  // A comma or semicolon can introduce a separate delivery/safety predicate.
  // Keep explicit Russian dependent «не могу подтвердить, что …» together.
  const parts = text.split(/((?<=[.!?\u2026;])\s+|\n+|,(?!\s*что(?!\p{L}))\s*)/iu);
  for (let i = 0; i < parts.length; i += 2) {
    const part = parts[i];
    const visible = part.replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, quote => ' '.repeat(quote.length));
    if (linkSubject.test(visible)) linkMentioned = true;
    if (!linkMentioned || !validity.test(visible) || /\?\s*$/u.test(visible)) continue;
    // Scope denial must actually govern the validity statement, never a later
    // unrelated medical or follow-up denial in the same answer.
    const asserted = visible.split(/(?<!\p{L})(?:но|бірақ)(?!\p{L})/iu);
    let offset = 0;
    for (const clause of asserted) {
      const start = visible.indexOf(clause, offset); offset = start + clause.length;
      if (/(?:растай\s+алмай|расталған\s+жоқ|жарамды\s+емес|не\s+(?:могу|можем)\s+(?:подтвердить|гарантировать)[^.!?]{0,70}(?:жарамд|действ|работ)|не\s+(?:действител\p{L}*|действует|работает)|деп\s+айтпаймын)/iu.test(clause)) continue;
      if (!linkSubject.test(clause) && /(?:доставка|жеткізу)/iu.test(clause)) continue;
      countryScope.lastIndex = 0;
      for (const match of clause.matchAll(countryScope)) {
        // Blank the modifier at its original offsets; quoted text was masked
        // above and cannot create either a claim or a removal candidate.
        const position = start + (match.index || 0);
        parts[i] = parts[i].slice(0, position) + ' '.repeat(match[0].length) + parts[i].slice(position + match[0].length);
      }
    }
  }
  const changed = parts.join('');
  return changed === text ? text : changed.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/gm, '').trim();
}

// Words that only exist inside the system: operator notes, kitchen status,
// context and tooling. A guest must never see any of them.
// "оператор" alone is NOT internal: the escalate tool's customerReply deliberately
// tells the guest a human will take over, and the contract says to send that text
// verbatim. Cutting every sentence containing the word deleted exactly that
// sentence - and on a short reply collapsed the whole answer to the generic
// fallback while a case had just been opened (found 2026-08-22). The guard exists
// to stop PROVENANCE leaking ("the operator note says..."), so the operator word
// now has to appear next to internal wording.
const INTERNAL_PROVENANCE_RE =
  /(\u0435\u0441\u043a\u0435\u0440\u0442\u043f|\u0437\u0430\u043c\u0435\u0442\u043a|\u043f\u0440\u0438\u043c\u0435\u0447\u0430\u043d\u0438|\u0436\u04af\u0439\u0435\u0434\u0435|\u0441\u0438\u0441\u0442\u0435\u043c\u0430\u0434\u0430|\u0441\u0442\u0430\u0442\u0443\u0441\u0442\u0430|kitchen[_ ]?status|note[s]?\b|context|instruction|prompt|tool\b)/i;
const OPERATOR_WORD_RE = /(\u043e\u043f\u0435\u0440\u0430\u0442\u043e\u0440|operator)/i;

function disclosesInternals(sentence: string) {
  if (INTERNAL_PROVENANCE_RE.test(sentence)) return true;
  // The operator word only counts when it is explaining where information came
  // from, i.e. paired with provenance wording in the same sentence.
  return OPERATOR_WORD_RE.test(sentence) && INTERNAL_PROVENANCE_RE.test(sentence);
}

const INTERNAL_DISCLOSURE_RE = INTERNAL_PROVENANCE_RE;

/** Detect clear foreign surrounding prose while preserving verified literal names. */
function replyProse(text:string,ctx:FastFoodContext):string {
 const config=ctx.config as Record<string,any>|undefined;
 const names=(ctx.menuSnapshot?.items||[]).flatMap((item:any)=>[item.name,item.composition]).filter((v:any)=>typeof v==="string"&&v.length<=500);
 for(const key of ["restaurant_name","business_name","agent_name","system_prompt","systemPrompt","custom_prompt","customPrompt"]){
  const value=config?.[key];if(typeof value!=="string")continue;
  if(key.endsWith("name"))names.push(value);
  else for(const match of value.slice(0,20000).matchAll(/(?:service\s+name|имя\s+(?:бота|сервиса)|название\s+сервиса|қызмет\s+атауы)\s*:?\s*([^.!?\n]{1,120})/giu)){
   if((match[1].match(/\p{L}+/gu)||[]).length<=8)names.push(match[1].trim().replace(/[«»“”"]/gu,""));
  }
 }
 let prose=text.replace(URL_RE," ");
 for(const name of names.filter(Boolean).sort((a:string,b:string)=>b.length-a.length)){
  const escaped = name.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  prose=prose.replace(new RegExp("(?<![\\p{L}\\p{N}])"+escaped+"(?![\\p{L}\\p{N}])","giu")," ");
 }
 return prose;
}
export function replyLanguageMismatch(text:string,ctx:FastFoodContext):boolean {
 const prose=replyProse(text,ctx);
 return (prose.match(SENTENCE_RE)||[prose]).some(sentence=>{
  const words=sentence.toLowerCase().match(/\p{L}+/gu)||[];
  const kk=new Set(words.filter(w=>/^(?:сіз|сізге|мені|деп|атай|аласыз|көмек|керек|жазыңыз|сұрақтарыңыз|болса|тапсырысыңыз|болады|қазір)$/u.test(w))).size;
  // Inflected Kazakh prose remains recognizable after literal catalog/brand
  // names were masked; a whole unrelated Russian sentence cannot hide it.
  const kkScript=new Set(words.filter(w=>KAZAKH_SPECIFIC_RE.test(w))).size;
  const ru=new Set(words.filter(w=>/^(?:вы|ваш|ваша|ваши|можете|если|хотите|сейчас|пожалуйста|пришлите|заказ|оплата|доставка|напишите|помочь|готов)$/u.test(w))).size;
  const english=new Set(words.filter(w=>/^(?:if|you|your|have|further|questions|feel|free|ask|please|can|order|delivery|would|like)$/u.test(w))).size;
  const foreignAffirmation=/^\s*(?:иә|жоқ)(?=$|[^\p{L}])/iu.test(sentence);
   // Clear Ukrainian surrounding prose is another language, including after a
   // failed rewrite. Masked catalog and service names never count as prose.
   const ukrainian=new Set(words.filter(w=>/^(?:дякую|готовність|чекати|напишіть|ласка|хочете|замовити|замовлення|можливість|унікальна|допоможу|будь|цим)$/u.test(w))).size;
   const ukrainianProse=ukrainian>=3||ukrainian>=2&&/[їєґ]/iu.test(sentence);
  return ctx.language==="ru"?(foreignAffirmation||ukrainianProse||(kk>=3||kkScript>=3)&&ru<2||english>=4&&ru<2):ctx.language==="kk"?(ukrainianProse||ru>=3&&kk<2||english>=4&&kk<2):false;
 });
}

function attributeVolumeMentions(value:string):number[] {
 return [...value.matchAll(/(?<![\p{L}\p{N}])(\d+(?:[.,]\d+)?)\s*(мл|ml|литр\p{L}*|л|l)(?!\p{L})/giu)]
  .map(match=>Number(match[1].replace(",","."))*(/^(?:мл|ml)$/iu.test(match[2])?1:1000));
}
/** A customer description resolves only the query, never catalog/availability authority. */
function freshCustomerAttributeVolume(ctx:FastFoodContext):number|null {
 const fold=(value:unknown)=>String(value||"").toLowerCase().replace(/ё/g,"е");
 const unquoted=(value:unknown)=>fold(value).replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu,"");
 const current=unquoted(ctx.text);
 const requestWords=new Set(["не","придумывайте","придумывай","замену","подтвердите","подтверди","проверьте","проверь","уточните","уточни","пожалуйста","объем","размер","по","меню"]);
 if((current.match(/\p{L}+/gu)||[]).some(word=>!requestWords.has(word)))return null;
 const now=Date.now();
 for(const row of (Array.isArray(ctx.chatHistory)?ctx.chatHistory:[]).slice(-12).reverse()){
  if(!row||row.role!=="user")continue;
  const text=unquoted(row.text??row.content??row.body??"").trim();if(text===current.trim())continue;
  if(row.instanceId&&row.instanceId!==ctx.instanceId||row.instance_id&&row.instance_id!==ctx.instanceId)return null;
  if(row.phone&&String(row.phone).replace(/\D/g,"")!==String(ctx.phone).replace(/\D/g,""))return null;
  const raw=row.createdAt??row.timestamp,at=typeof raw==="number"?raw:Date.parse(String(raw||""));
  if(!Number.isFinite(at)||at>now||at<=now-30*60_000)return null;
  const quantities=attributeVolumeMentions(text);
  if(quantities.length!==1||!Number.isFinite(quantities[0])||quantities[0]<=0)return null;
  const noun=text.replace(/^(?:(?:у\s+вас\s+)?есть(?:\s+ли)?|сколько\s+стоит|цена)\s+/iu,"")
   .replace(/\s*\d+(?:[.,]\d+)?\s*(?:мл|ml|литр\p{L}*|л|l)[.!?]*$/iu,"").trim();
  if(noun===text||!/^(?:[\p{L}-]{3,}\s+){0,3}[\p{L}-]{3,}$/u.test(noun)
   ||/(?<!\p{L})(?:он|она|оно|это|его|ее|и|или|және|немесе)(?!\p{L})/iu.test(noun))return null;
  return quantities[0];
 }
 return null;
}
function groundedAttributeNegative(text:string,ctx:FastFoodContext,volume:number):string|null {
  const source=String(ctx.menuSnapshot?.source||"");
  if(!hasCurrentCompositionCatalog(ctx)||!/(?:dle_spa_items|catalog_current|live_menu)/u.test(source)
   ||namedMenuItems(ctx,text).length)return null;
  // A verified component volume contradicts global absence, without proving
  // that the component is a standalone purchasable SKU.
  if((ctx.menuSnapshot?.items||[]).some((item:any)=>attributeVolumeMentions(
   String(item.name||item.title||"")+" "+String(item.composition||item.ingredients||"")
  ).includes(volume)))return null;
  const negatives=(text.match(SENTENCE_RE)||[text]).filter(sentence=>!nonCurrentFactAssertion(sentence)&&!/\?/u.test(sentence)
   &&/(?<!\p{L})(?:нет|отсутств\p{L}*|не\s+(?:найден\p{L}*|представлен\p{L}*))(?!\p{L})/iu.test(sentence)
   &&attributeVolumeMentions(sentence).length===1&&attributeVolumeMentions(sentence)[0]===volume);
  // Matching one factual negative does not authorize independent raw claims.
  return negatives.length?negatives.map(sentence=>sentence.trim()).join(" "):null;
}

function validateFinalTextCore(
  rawText: string,
  ctx: FastFoodContext,
  // toolFindings carries what the tools actually RETURNED. A gate that only knows a
  // tool was called cannot tell "the order exists" from "the lookup came back empty",
  // and the model is at its most confident precisely when the lookup failed. When the
  // caller supplies no findings, no positive lookup claim is authorized.
  grounding?: { toolsCalled?: string[]; toolFindings?: ToolGroundingFindings }
): {
  text: string;
  hasLink: boolean;
  warnings: string[];
} {
  const protocolSafe = stripToolProtocolArtifacts(String(rawText || "").trim());
  let text = stripBotTags(protocolSafe.text);
  const warnings: string[] = protocolSafe.removed ? ["tool_protocol_removed"] : [];
  if(customerMenuRelationSubject(ctx)?.needsClarification){
    const attribute=isMenuAttributeVerificationQuestion(ctx.text);
    const reference=attribute?freshCustomerAttributeVolume(ctx):null;
    if(reference!==null){
      const negative=groundedAttributeNegative(text,ctx,reference);
      if(negative===null){
        text=ctx.language==="kk"?"Сұралған көлемді мәзір деректерімен қазір растай алмаймын.":"Запрошенный объём по данным меню сейчас подтвердить не могу.";
        warnings.push("menu_attribute_unverified");
      }else{
        if(negative!==text.trim())warnings.push("menu_attribute_unverified");
        text=negative;
      }
    }else{
      text=attribute
        ?ctx.language==="kk"?"Қай өнімнің көлемін тексеру керек екенін нақтылаңыз. Көлемін мәзір деректерімен ғана растай аламын.":"Уточните, объём какого товара нужно проверить. Объём могу подтвердить только по данным меню."
        :ctx.language==="kk"?"Қай өнімді айтып тұрғаныңызды нақтылаңыз: бөлек сатыла ма, әлде комбо құрамында ма?":"Уточните, какой товар вы имеете в виду: продаётся ли он отдельно или входит в комбо?";
      warnings.push("menu_relation_reference_clarification");
    }
  }

  if (!text) return { text: fallback(ctx), hasLink: false, warnings: [...warnings, "empty_model_output"] };

  const internalError = /TOOL_CHOICE_IGNORED|TEXT_MODEL_TIMEOUT|HEDGE_LOSER_ABORTED|Incident\s+ID|stack\s+trace/iu;
  if (internalError.test(text)) {
    text = dropSentencesMatching(text, internalError);
    warnings.push("internal_error_identifier_removed");
    if (!text) return { text: fallback(ctx), hasLink: false, warnings };
  }

  // Before any other guard: a narrated "Silent Thought: ..." preamble is not part of the
  // answer, and leaving it in front meant every regex below measured the wrong sentence.
  const planning = stripResponsePlanning(text,ctx,grounding?.toolsCalled||[]);
  if(planning.removed){warnings.push("reasoning_preamble_removed");text=planning.text;}
  const preamble = stripReasoningPreamble(text);
  if (preamble.removed) {
    warnings.push("reasoning_preamble_removed");
    text = preamble.text;
    if (!text) return { text: fallback(ctx), hasLink: false, warnings: [...warnings, "reasoning_preamble_was_whole_reply"] };
  }

  // Calling a read-only tool must not unlock a write-authority claim. "Ваш заказ
  // принят, напишите адрес" shipped whenever checkOrderStatus had run, even when it
  // returned lookup:"not_found" - so the guest waited for food that was never entered
  // anywhere (found 2026-08-22). The tool now has to have FOUND something.
  const statusCalled = Boolean(grounding?.toolsCalled?.includes("checkOrderStatus"));
  const orderFound = grounding?.toolFindings?.orderFound;
  const orderLookup = grounding?.toolFindings?.orderLookup;
  const statusGrounded = statusCalled && orderFound === true && (!orderLookup || orderLookup === "found");
  const orderEvidence = statusCalled ? (statusGrounded ? grounding?.toolFindings : null) : ctx.activeOrder;
  const fulfillment=orderEvidence?.orderFulfillmentType??(orderEvidence as any)?.fulfillmentType;
  if(orderEvidence&&activeOrderQuestionKind(ctx.text,orderEvidence)==="fulfillment"&&["pickup","delivery"].includes(String(fulfillment))){
    text=fulfillment==="pickup"
      ?ctx.language==="kk"?"Бұл тапсырысты өзіңіз алып кетесіз.":"Ваш текущий заказ оформлен на самовывоз."
      :ctx.language==="kk"?"Бұл тапсырыс жеткізумен рәсімделген.":"Ваш текущий заказ оформлен с доставкой.";
    warnings.push("order_fulfillment_grounded");
  }
  const manualWrite = isActionAssertion(text, (sentence) => MANUAL_ORDER_WRITE_CLAIM_RE.test(sentence)
    || isManualOrderHandlingClaim(sentence.replace(ACCEPTED_ORDER_CLAIM_RE, "")));
  if (manualWrite || (!orderEvidence && isActionAssertion(text, ACCEPTED_ORDER_CLAIM_RE))) {
    const statusIntent = isCustomerOrderStatusQuestion(ctx.text || "")
      || (Boolean(ctx.activeOrder) && isLikelyOrderStatusFollowUp(ctx.text || ""));
    const recoveryText = statusIntent
      ? (statusCalled && orderLookup === "not_found" ? noActiveOrderText(ctx) : orderStatusUnknownText(ctx))
      : (ctx.language === "kk" ? "Чатта тапсырысты өзім рәсімдей алмаймын. Жаңа тапсырысты сайт арқылы жасай аласыз."
        : "Я не оформляю заказы в чате. Новый заказ можно оформить на сайте.");
    return {
      text: recoveryText,
      hasLink: false,
      warnings: ["manual_order_claim_blocked"],
    };
  }

  if (!orderEvidence && isActionAssertion(text, (sentence) => customerProductReadyClaim(sentence, ctx), ctx)) {
    text = (textWithoutUrls(text).match(SENTENCE_RE) || [text]).filter((sentence) =>
      !isActionAssertion(sentence, (claim) => customerProductReadyClaim(claim, ctx), ctx)).join(" ").trim();
    warnings.push("unconfirmed_product_readiness_removed");
    if (!text) return { text: orderStatusUnknownText(ctx), hasLink: false, warnings };
  }

  // A found/unverified order proves neither receipt upload nor receipt receipt.
   // The customer-safe receipt_review projection is the existing explicit proof.
   const receiptStage=String(orderEvidence?.orderStage??(orderEvidence as any)?.stage??"");
   const receiptPayment=String(orderEvidence?.orderPaymentStatus??(orderEvidence as any)?.paymentStatus??"");
   const receiptProven=Boolean(orderEvidence)&&(receiptStage==="receipt_review"
     ||["receipt_review","receipt_uploaded","pending_review"].includes(receiptPayment));
   const receiptAssertion=(value:string)=>isActionAssertion(value,(sentence:string)=>!nonCurrentFactAssertion(sentence)
     &&!/(?:чек\p{L}*\s+(?:ещ[её]\s+)?не\s+(?:получ|отправ)|(?:чек|түбіртек)[^.!?]{0,25}(?:жіберілмеген|алынбаған|келген\s+жоқ)|чег\p{L}*[^.!?]{0,25}(?:жіберілмеген|алынбаған))/iu.test(sentence)
     &&/(?:чек\p{L}*|чег\p{L}*|түбіртек\p{L}*)[^.!?]{0,35}(?:отправлен|получен|загружен|прислан|жіберіл(?:ді|ген)|алын(?:ды|ған))|(?:отправлен|получен|загружен|прислан)[^.!?]{0,35}чек/iu.test(sentence));
   if(!receiptProven&&receiptAssertion(text)){
     text=removeUnsupportedActionClauses(text,receiptAssertion);
     const knownUnverified=["unverified","awaiting_receipt","pending"].includes(receiptPayment);
     const receiptUncertainty=ctx.language==="kk"?"Төлем чегінің алынғанын қазір растай алмаймын":"Получение платёжного чека сейчас подтвердить не могу";
     // A removed receipt assertion cannot leave its dependent negative without a subject.
     text=text.replace(/(^|[.!?]\s+)(?:ол\s+)?әлі\s+расталма(?:ды|ған)(?=\s*(?:[.!?]|$))/giu,
       (_whole,prefix)=>prefix+(knownUnverified?"Төлем әлі расталмады":receiptUncertainty));
     text=text.replace(/(^|[.!?]\s+)(?:(?:он|она|это)\s+)?(?:ещ[её]|пока)\s+не\s+подтвержд[её]н(?:а|о|ы)?(?=\s*(?:[.!?]|$))/giu,
       (_whole,prefix)=>prefix+(knownUnverified?"Оплата пока не подтверждена":receiptUncertainty));
     warnings.push("unconfirmed_payment_receipt_removed");
     if(!textWithoutUrls(text))return {text:ctx.language==="kk"?"Төлем чегінің алынғанын қазір растай алмаймын.":"Получение платёжного чека сейчас подтвердить не могу.",hasLink:false,warnings};
   }

   const wrongState = Boolean(orderEvidence) && isActionAssertion(text, (sentence) => orderStateClaimMatches(sentence, orderEvidence, ctx) === false, ctx);
  if (wrongState) {
    const kept = (textWithoutUrls(text).match(SENTENCE_RE) || [text]).filter((sentence) =>
      !isActionAssertion(sentence, (claim) => orderStateClaimMatches(claim, orderEvidence, ctx) === false, ctx)).join(" ").trim();
    warnings.push("order_state_mismatch_removed");
    text = kept;
    if (!text) return { text: ctx.language === "kk" ? "Тапсырыстың бұл кезеңін растай алмаймын. Тапсырыс нөмірін жазыңызшы."
      : "Не могу подтвердить этот этап заказа. Уточните, пожалуйста, номер заказа.", hasLink: false, warnings };
  }

  // Cancelling is the same boundary in the other direction, and it has no grounding that
  // could make it true: no tool in this agent can change order state. "Жарайды,
  // тапсырысыңызды тоқтатамыз" shipped to a guest who asked to cancel, so they stopped
  // waiting for a cancellation nobody had been asked to perform (found 2026-08-24). The
  // deterministic cancel lane in the webhook does not pass through this validator, so its
  // honest handoff wording is unaffected.
  if (isManualOrderCancellationClaim(text)) {
    return {
      text: manualCancellationBoundaryText(ctx.language, grounding?.toolFindings?.escalationCreated === true),
      hasLink: false,
      warnings: [...warnings, "manual_cancellation_claim_blocked"],
    };
  }

  // A delivery-zone refusal is never a fact this agent holds - see
  // DELIVERY_ZONE_REFUSAL_RE. Cut the clause; if it was the whole reply, say the honest
  // thing instead of letting an invented boundary end the sale.
  DELIVERY_ZONE_REFUSAL_RE.lastIndex = 0;
  if (DELIVERY_ZONE_REFUSAL_RE.test(text)) {
    DELIVERY_ZONE_REFUSAL_RE.lastIndex = 0;
    const withoutZoneRefusal = dropSentencesMatching(text, DELIVERY_ZONE_REFUSAL_RE);
    warnings.push("invented_delivery_zone_removed");
    if (!textWithoutUrls(withoutZoneRefusal)) {
      return { text: deliveryZoneUnknownText(ctx.language), hasLink: false, warnings };
    }
    text = withoutZoneRefusal;
  }

  // A fabricated notification is removed; it must never become a reason to create SOS.
  const caseCreated = grounding?.toolFindings?.escalationCreated === true;
  const notificationAccepted = caseCreated && grounding?.toolFindings?.escalationNotificationAccepted === true;
  const unverifiedEscalation = (sentence: string) => (!caseCreated
    && (isActionAssertion(sentence, PAST_ESCALATION_CLAIM_RE) || isActionAssertion(sentence, OPERATOR_NOTIFICATION_CLAIM_RE)))
    || (!notificationAccepted && (isActionAssertion(sentence, CONFIRMED_OPERATOR_NOTIFICATION_RE)
      || isActionAssertion(sentence, CONFIRMED_HUMAN_CONTACT_RE)));
  PAST_ESCALATION_CLAIM_RE.lastIndex = 0;
  if (unverifiedEscalation(text)) {
    text = removeUnsupportedActionClauses(text, unverifiedEscalation);
    PAST_ESCALATION_CLAIM_RE.lastIndex = 0;
    warnings.push("unverified_operator_notification_removed");
    if (!textWithoutUrls(text)) return { text: unverifiedHumanActionText(ctx, caseCreated, notificationAccepted), hasLink: false, warnings };
  }

  const unverifiedHumanAction = (sentence: string) =>
    (!caseCreated && promisedHumanAction(sentence, FUTURE_HUMAN_ACTION_RE))
    || (!notificationAccepted && promisedHumanAction(sentence, FUTURE_HUMAN_CONTACT_RE))
    || (HUMAN_CONTACT_TIME_RE.test(sentence) && promisedHumanAction(sentence, FUTURE_HUMAN_CONTACT_RE))
    || promisedHumanAction(sentence, KITCHEN_ACTION_RE)
    || promisedHumanAction(sentence, KITCHEN_CHECK_CAPABILITY_RE)
    || isActionAssertion(sentence, /(?:оператор|администратор|әкімш)[^.!?]{0,40}(?:работает\s+над|решает|разбирает|изучает|мәселені\s+шеш|қарастырып\s+жатыр)/iu);
  if (unverifiedHumanAction(text)) {
    text = removeUnsupportedActionClauses(text, unverifiedHumanAction);
    warnings.push("unverified_human_action_removed");
    if (!textWithoutUrls(text)) return { text: /құрам|состав|орех|жаңғақ|аллерг/iu.test(ctx.text)
      ? allergenUnverifiedText(ctx)
      : unverifiedHumanActionText(ctx, caseCreated, notificationAccepted), hasLink: false, warnings };
  }

  // Removing fabricated ingredients cannot leave a health reassurance behind.
  // Current customer allergy context and the claim's own subject bound this gate.
  if (unverifiedAllergyReassurance(text, ctx)) {
    const sentences = text.match(SENTENCE_RE) || [text];
    const removed = sentences.filter((sentence) => unverifiedAllergyReassurance(sentence, ctx));
    // Preserve the established diagnostic when this earlier gate also removes
    // the same unsafe blanket claim. Bare reassurance remains its own category.
    const blanket = new RegExp(BLANKET_ALLERGEN_ASSURANCE_RE.source, BLANKET_ALLERGEN_ASSURANCE_RE.flags.replace(/[gy]/g, ""));
    if (removed.some(sentence => blanket.test(sentence))) warnings.push("blanket_allergen_assurance_removed");
    text = sentences.filter((sentence) => !unverifiedAllergyReassurance(sentence, ctx)).join(" ").trim();
    warnings.push("unverified_allergy_reassurance_removed");
    // A choice prompt with no remaining choices is not an allergy answer.
    if (/^(?:Қайсысын\s+таңдайсыз|Что\s+выберете|Какое\s+выберете)[?!.,\s]*$/iu.test(text)) text = "";
    if (!hasHonestSafetyGuaranteeDenial(text)) text = [safetyGuaranteeDenialText(ctx), text].filter(Boolean).join(" ");
  }

  // A truncated generation once shipped the single word "Өкі" to a guest. A reply that
  // short with no sentence ending and no URL is a broken fragment, not an answer.
  // A closing emoji ends a sentence too: the prompt's own example greeting «Сәлем! 😊»
  // was thrown away as a fragment and replaced by the fallback (live, 2026-10-04).
  const looksUnfinished = text.length < 12 && !/[.!?…:)\p{Extended_Pictographic}\uFE0F]$/u.test(text) && !hasLinkInResponse(text);
  if (looksUnfinished) {
    return { text: fallback(ctx), hasLink: false, warnings: ["truncated_model_output"] };
  }

  // Foreign-script corruption is a transport/model failure, not a style issue.
  if (FORBIDDEN_FOREIGN_SCRIPT_RE.test(text)) {
    return { text: fallback(ctx), hasLink: false, warnings: ["foreign_script_output"] };
  }
  // Mixed-language heuristics are diagnostic only. Product and brand names often
  // legitimately cross the language boundary, so replacing the whole answer with
  // a generic phrase destroyed otherwise useful replies.
  if (replyLanguageMismatch(text,ctx)) warnings.push("reply_language_mismatch");
  if (ctx.language === "ru" && KAZAKH_SPECIFIC_RE.test(replyProse(text,ctx))) {
    warnings.push("possible_kazakh_in_russian_reply");
  }
  if (ctx.language === "kk" && RUSSIAN_SERVICE_WORD_RE.test(replyProse(text,ctx))) {
    warnings.push("possible_russian_in_kazakh_reply");
  }

  // Safety-critical factual guards remain deterministic, but they now cut the
  // offending clause instead of throwing away a whole useful answer. Replacing
  // the entire reply with a canned line is what made the bot feel dead: one
  // stale runtime read turned a good menu answer into "I cannot check that".
  if (!ctx.runtimeStatus || ctx.runtimeStatus.runtime_available === false || ctx.hardRealtimeContext?.stale) {
    if (ctx.runtimeStatus?.runtime_available === false) {
      const before=text;
      const unknownRuntime=(sentence:string)=>isActionAssertion(sentence, (clause:string)=>KITCHEN_STATUS_RE.test(clause)
        &&!nonCurrentFactAssertion(clause)
        &&!(ctx.config?.work_hours&&/(?:график|расписани|кесте)/iu.test(clause)&&/\d{1,2}(?::\d{2})?/.test(clause)&&!/(?:сейчас|қазір|значит|демек)/iu.test(clause)))
        || isActionAssertion(sentence, /(?:заказы|тапсырыстар)[^.!?]{0,35}(?:принима|қабылд)|(?:күту\s+уақыты|время\s+ожидания|күту)[^.!?]{0,30}\d+\s*(?:минут|мин|сағат)|без\s+ожидания|(?:ждать|ожидани\p{L}*)[^.!?]{0,35}(?:не\s+требуется|не\s+нужно|не\s+надо)|күту\p{L}*[^.!?]{0,35}(?:қажет\p{L}*\s+(?:жоқ|емес)|керек\s+емес)/iu);
      if(unknownRuntime(text))text=removeUnsupportedActionClauses(text,unknownRuntime);
      if(text!==before){
        warnings.push("unsupported_kitchen_claim_clause_removed");
        if(text&&/(?:ждать|ожидан|күту|қанша|белгісіз|неизвест|подтвержден|расталған)/iu.test(ctx.text))
          text=(ctx.language==="kk"?"Асүйдің жұмысын және күту уақытын қазір растай алмаймын.":"Работу кухни и время ожидания сейчас подтвердить не могу.")+" "+text;
      }
      const menuReply=mixedMenuAvailabilityReply(ctx,grounding?.toolsCalled||[]);
      if(menuReply&&!namedMenuItems(ctx,text).length){
        text=dropSentencesMatching(text,/(?:мәзір[^.!?]{0,40}тексерсем\s*бе|(?:проверить|посмотреть)[^.!?]{0,30}меню[^.!?]{0,10}\?)/iu);
        text=[text||runtimeUnavailableText(ctx),menuReply].join(" ");
      }
      if(!text)return {text:runtimeUnavailableText(ctx),hasLink:false,warnings:[...warnings,"unsupported_kitchen_claim"]};
    }
    if (ctx.runtimeStatus?.runtime_available !== false && KITCHEN_STATUS_RE.test(text)) {
      const withoutKitchenClaims = dropSentencesMatching(text, KITCHEN_STATUS_RE);
      if (withoutKitchenClaims) {
        text = withoutKitchenClaims;
        warnings.push("unsupported_kitchen_claim_clause_removed");
      } else {
        return { text: runtimeUnavailableText(ctx), hasLink: false, warnings: [...warnings, "unsupported_kitchen_claim"] };
      }
    }
  }

  const liveWaitTime = Number(ctx.fetchedSettings?.wait_time || 0);
  // A tool that re-read the kitchen or the business info this turn is a live
  // source, and preload's snapshot is not the only truth: getKitchenStatus calls
  // the hub with forceFresh, so a wait raised after preload was being stripped out
  // of a correct answer, and getBusinessInfo's work hours ("тәулік бойы 24 сағат")
  // were eaten by the same duration regex (found 2026-08-22).
  const durationGrounded = Boolean(
    grounding?.toolsCalled?.includes("getKitchenStatus") || grounding?.toolsCalled?.includes("getBusinessInfo")
  );
  if (!liveWaitTime && !durationGrounded) {
    if (STALE_WAIT_CONSENT_RE.test(text)) {
      const withoutStaleConsent = dropSentencesMatching(text, STALE_WAIT_CONSENT_RE);
      if (withoutStaleConsent) {
        text = withoutStaleConsent;
        warnings.push("stale_wait_consent_removed");
      }
    }
    WAIT_TIME_CLAIM_RE.lastIndex = 0;
    const hasUnsupportedWaitClaim = WAIT_TIME_CLAIM_RE.test(text);
    WAIT_TIME_CLAIM_RE.lastIndex = 0;
    if (hasUnsupportedWaitClaim) {
      const strippedTimeClaims = text.replace(WAIT_TIME_CLAIM_RE, "").replace(/\s{2,}/g, " ").trim();
      // Never let the guard empty the whole reply. Before, a one-sentence answer
      // that mentioned a duration was deleted down to nothing and the customer
      // received the generic fallback instead of an answer.
      if (strippedTimeClaims) {
        text = strippedTimeClaims;
        warnings.push("unsupported_wait_claim_removed");
      } else {
        warnings.push("unsupported_wait_claim_only_sentence");
      }
    }
    if (SOFT_WAIT_HINT_RE.test(text)) warnings.push("polite_wait_phrase_kept");
  }

  // statusGrounded matters here too: checkOrderStatus can find an order by a
  // quoted number that preload's phone lookup missed, so ctx.activeOrder is empty
  // while the tool has just read the real order. Cutting the sentence then makes
  // the bot deny an order it verified one step earlier (found 2026-08-22).
  if (!ctx.activeOrder && !statusGrounded && ORDER_STATUS_RE.test(text)) {
    // Same principle as the kitchen guard: cut the false order claim, keep the
    // rest of the answer. Only when nothing survives do we fall back to the
    // deterministic "no active order" line.
    // A sentence about the link sendMenuLink granted this turn is an invitation to
    // order ("собрать заказ и оформить доставку"), not a status claim. Cutting it
    // answered "кидай ссылку" with "Сейчас нет активного заказа." (audit sim 2026-10-04).
    const withoutOrderClaims = dropSentencesMatchingUnless(text, ORDER_STATUS_RE,
      ctx.magicLinkGranted === true ? (sentence) => /(ссылк|сілтеме|link)/iu.test(sentence) : null);
    if (withoutOrderClaims) {
      text = withoutOrderClaims;
      warnings.push("unsupported_order_claim_clause_removed");
    } else {
      return { text: statusCalled && orderLookup === "not_found" ? noActiveOrderText(ctx) : orderStatusUnknownText(ctx), hasLink: false, warnings: [...warnings, "unsupported_order_claim"] };
    }
  }

  // Internal provenance must never reach a guest. A model under pressure likes
  // to justify itself ("the operator note says..."), which exposes kitchen
  // shorthand written for staff. The sentence carrying the disclosure is cut,
  // not the whole reply, so the useful part of the answer survives.
  if (INTERNAL_PROVENANCE_RE.test(text)) {
    const kept = text
      .split(/(?<=[.!?\u2026])\s+|\n+/)
      .filter((sentence) => !disclosesInternals(sentence))
      .join(" ")
      .replace(/\s{2,}/g, " ")
      .trim();
    warnings.push("internal_disclosure_removed");
    text = kept;
    if (!text) return { text: fallback(ctx), hasLink: false, warnings };
  }

  // Link integrity and duplicate suppression are transport contracts.
  // Two ways a link becomes unrequested: the turn never carried order intent,
  // or the agent's own sendMenuLink skill declined it this turn (kitchen
  // closed, or a link was already issued today) and the model pasted the URL
  // anyway. magicLinkGranted is undefined for older callers and unit tests, so
  // their behaviour is unchanged.
  const linkDeclinedThisTurn = ctx.magicLinkGranted === false;
  const hasUnrequestedMenuLink = Boolean(
    ctx.magicLink
    && (!ctx.explicitMenuLinkIntent || linkDeclinedThisTurn)
    && uniqueUrls(text).some((url) => isLikelyMagicLinkUrl(url, ctx.magicLink || ""))
  );
  if (hasUnrequestedMenuLink) {
    text = text.replace(URL_RE, (url) =>
      isLikelyMagicLinkUrl(trimUrlPunctuation(url), ctx.magicLink || "") ? "" : url
    ).replace(/\s{2,}/g, " ").trim();
    warnings.push(ctx.magicLinkAlreadySent ? "duplicate_menu_link_removed" : "unrequested_menu_link_removed");
    if (MENU_LINK_SENT_RE.test(text)) return { text: text || fallback(ctx), hasLink: false, warnings };
    return { text: text || fallback(ctx), hasLink: false, warnings };
  }

  // The bot never has a reason to type a URL of its own: the personal link comes from
  // sendMenuLink and business info carries none. "https://dorumclub.kz/order" was
  // invented by the model and would have reached the guest as a dead link (audit sim
  // 2026-10-04). Kept: the personal link (and look-alikes, rewritten below), any host
  // the tenant config names, and a URL already present in this chat.
  const knownUrlSources = JSON.stringify([ctx.config || {}, ctx.chatHistory || []]).toLowerCase();
  const inventedUrls = uniqueUrls(text).filter((url) => {
    if (ctx.magicLink && isLikelyMagicLinkUrl(url, ctx.magicLink)) return false;
    try {
      return !knownUrlSources.includes(new URL(url).hostname.toLowerCase());
    } catch {
      return true;
    }
  });
  if (inventedUrls.length) {
    text = text.replace(URL_RE, (url) => (inventedUrls.includes(trimUrlPunctuation(url)) ? "" : url))
      .replace(/[ \t]{2,}/g, " ").replace(/\n{2,}/g, "\n").trim();
    warnings.push("invented_url_removed");
    if (!textWithoutUrls(text)) return { text: fallback(ctx), hasLink: false, warnings };
  }

  text = enforceExactMagicLink(text, ctx);
  const supportedLinkText = stripUnsupportedLinkGeography(text, ctx);
  if (supportedLinkText !== text) {
    text = supportedLinkText;
    warnings.push("unsupported_link_geography_removed");
  }


  // Ungrounded factual claims: only enforced when the caller reports which
  // tools actually ran this turn. When the report is absent (older callers,
  // unit tests), behavior is byte-identical to before.
  if (grounding && Array.isArray(grounding.toolsCalled)) {
    // The preloaded snapshot is a grounding source, not a hint: menu_snapshot.rule
    // in buildFactsPrompt explicitly authorises selling a listed dish at the price
    // shown. Requiring a tool call on top of that deleted prices the prompt had
    // just told the model to quote - and MENU_LOOKUP_RE does not catch every way a
    // guest asks ("Пицца почем?"), so no tool ran (found 2026-08-22).
    const catalogUnavailable=ctx.menuSnapshot?.source==="menu_unavailable"||(ctx.menuGrounding as any)?.menu_lookup==="unavailable";
    const snapshotPrices = !catalogUnavailable && Array.isArray(ctx.menuSnapshot?.items) && ctx.menuSnapshot!.items.length > 0;
    const toolGrounded = grounding.toolsCalled.some((tool) => PRICE_GROUNDING_TOOLS.includes(tool) && (tool!=="searchMenu" || !catalogUnavailable));
    const grounded = snapshotPrices || toolGrounded;
    if (snapshotPrices && PRICE_CLAIM_RE.test(text)
      && (ctx.menuGrounding || !grounding.toolsCalled.some((tool) => tool === "checkOrderStatus" || tool === "getPaymentDetails"))) {
      const checked = validateMenuPriceClaims(text, ctx);
      if (checked !== text) {
        warnings.push("menu_price_mismatch_removed");
        text = checked;
        if (!textWithoutUrls(text)) return { text: ctx.language === "kk" ? "Бұл бағаны қазір растай алмаймын." : "Сейчас не могу подтвердить эту цену.", hasLink: false, warnings };
      }
    }
    if (!grounded) {
      if (PRICE_CLAIM_RE.test(text)) {
        const withoutPrices = dropSentencesMatching(text, PRICE_CLAIM_RE);
        if (withoutPrices && withoutPrices !== text) {
          text = withoutPrices;
          warnings.push("ungrounded_price_claim_removed");
        } else {
          return {text:ctx.language === "kk" ? "Бағаны қазір растай алмаймын." : "Сейчас не могу подтвердить цену.",hasLink:false,warnings:[...warnings,"ungrounded_price_claim_removed"]};
        }
      }
      // Deliberately NOT relaxed by the snapshot: telling a guest an allergen is
      // absent is the one lie that can put them in hospital, and a composition
      // string is not a verified allergen statement. This still demands a tool.
    }
    // Outside the price block on purpose: a snapshot may authorise a price, never a bare
    // promotion. An operator who is running a campaign writes it in the shift notes, and
    // getShiftNotes surfaces those.
    //
    // The one other real source is the catalog itself: a dish whose live record carries a
    // crossed-out old price IS discounted, and the storefront shows that discount to the
    // same guest. Cutting those sentences too made the bot deny a promotion its own site
    // was advertising, on every tenant that uses the feature (found 2026-08-24). So a promo
    // sentence survives when it names such a dish - the fact travels with the sentence.
    const promoInNotes = (Array.isArray(ctx.activeShiftNotes) ? ctx.activeShiftNotes : [])
      .some((note: unknown) => PROMO_NOTE_RE.test(typeof note === "string" ? note : JSON.stringify(note ?? "")));
    const discounted = discountedMenuNames(ctx);
    const namesDiscountedDish = discounted.length
      ? (sentence: string) => {
          const lower = sentence.toLowerCase();
          return discounted.some((name) => lower.includes(name.toLowerCase()));
        }
      : null;
    // A percentage is never in the catalog: the menu carries prices, not "20% off". So a
    // percent claim stays ungrounded even in a reply that also names real discounts.
    const PERCENT_DISCOUNT_RE = /\d{1,3}\s*%/u;
    // When the reply already names a genuinely discounted dish, the promo TOPIC is grounded
    // for this reply, and the framing sentence around it ("Қазір мынадай акциялар бар:")
    // is part of the same true statement. Cutting it left the answer starting mid-thought
    // with "Мысалы:" (live QA R5-02.1). Percent claims are still cut individually.
    const replyIsGroundedPromo = Boolean(namesDiscountedDish)
      && (textWithoutUrls(text).match(SENTENCE_RE) || []).some((sentence) =>
        namesDiscountedDish!(sentence) && !PERCENT_DISCOUNT_RE.test(sentence));
    const keepPromoSentence = replyIsGroundedPromo
      ? (sentence: string) => !PERCENT_DISCOUNT_RE.test(sentence)
      : namesDiscountedDish;
    if (!promoInNotes && PROMO_CLAIM_RE.test(text)) {
      const withoutPromos = dropSentencesMatchingUnless(text, PROMO_CLAIM_RE, keepPromoSentence);
      if (withoutPromos && withoutPromos !== text) {
        text = withoutPromos;
        warnings.push("unverified_promo_claim_removed");
      } else if (withoutPromos === text) {
        // Nothing was cut: every promo sentence named a genuinely discounted dish.
        if (namesDiscountedDish) warnings.push("promo_claim_grounded_by_menu");
        else warnings.push("unverified_promo_claim_kept_no_survivor");
      } else if (!textWithoutUrls(withoutPromos)) {
        // The promotion was the whole answer. Warning and shipping it anyway is how an
        // invented discount reached the guest.
        return { text: promoUnverifiedText(ctx), hasLink: false, warnings: [...warnings, "unverified_promo_claim_replaced"] };
      } else {
        warnings.push("unverified_promo_claim_kept_no_survivor");
      }
    }
    // Same reasoning, one step stricter: only a menu read can say what is in a dish.
    // A menu read only grounds "no nuts" when the catalog carries ingredients at all. The
    // dorumclub catalog has none, so one searchMenu call unlocked «құрамында жаңғақ жоқ»
    // written from general knowledge (audit sim 2026-10-04). Only an explicit empty
    // composition on every item counts; a snapshot that says nothing changes nothing.
    // And a blanket claim over the whole menu is cut even WITH the menu read, because no
    // tool result can support it - see BLANKET_ALLERGEN_ASSURANCE_RE.
    BLANKET_ALLERGEN_ASSURANCE_RE.lastIndex = 0;
    if (BLANKET_ALLERGEN_ASSURANCE_RE.test(text)) {
      BLANKET_ALLERGEN_ASSURANCE_RE.lastIndex = 0;
      text = dropSentencesMatchingUnless(text, BLANKET_ALLERGEN_ASSURANCE_RE, isCompositionUncertaintyOnly);
      warnings.push("blanket_allergen_assurance_removed");
      if (!textWithoutUrls(text)) return { text: allergenUnverifiedText(ctx), hasLink: false, warnings };
    }
    const menuRead = grounding.toolsCalled.some((tool) => ALLERGEN_GROUNDING_TOOLS.includes(tool));
    if (ALLERGEN_ASSURANCE_RE.test(text) || FOOD_SAFETY_ASSURANCE_RE.test(text)) {
      const assurancePattern = new RegExp(`(?:${ALLERGEN_ASSURANCE_RE.source})|(?:${FOOD_SAFETY_ASSURANCE_RE.source})`, "iu");
      const withoutAssurance = dropSentencesMatchingUnless(text, assurancePattern,
        (sentence) => isCompositionUncertaintyOnly(sentence) || (menuRead && menuSupportsAllergenAbsence(sentence, ctx)));
      if (withoutAssurance !== text) {
        text = withoutAssurance;
        warnings.push("ungrounded_allergen_assurance_removed");
        if (!textWithoutUrls(text)) return { text: allergenUnverifiedText(ctx), hasLink: false, warnings };
      }
    }
    const compositionClaim = /(?:содержит|в\s+составе|состав\s*:|құрамында|құрамы\s*[:—-])/iu;
    if (compositionClaim.test(text)) {
      const withoutInventedIngredients = validateMenuCompositionClaims(text, ctx);
      if (withoutInventedIngredients !== text) {
        text = withoutInventedIngredients;
        warnings.push("unsupported_ingredient_claim_removed");
        if (!textWithoutUrls(text)) return { text: allergenUnverifiedText(ctx), hasLink: false, warnings };
      }
    }
    // Only when something was actually cut above. DANGLING_REFERENCE_RE is anchored
    // ^...$, so it matches a whole one-sentence reply that merely opens with a
    // demonstrative - and it used to run unconditionally, which deleted fully grounded
    // answers like "Бұл тағам 2500 теңге тұрады." and "Осы тағам дайын." and replaced
    // them with "I cannot confirm the composition". In Kazakh that opener is ordinary
    // (found 2026-08-22). A pointer is only dangling if the thing it pointed at was
    // just removed.
    const somethingWasCut = warnings.some((warning) => warning.endsWith("_removed") || warning.endsWith("_replaced"));
    if (somethingWasCut && DANGLING_REFERENCE_RE.test(text)) {
      const anchored = dropSentencesMatching(text, DANGLING_REFERENCE_RE);
      if (anchored !== text) {
        text = anchored;
        warnings.push("dangling_reference_removed");
      }
      if (!textWithoutUrls(text)) {
        // The allergen line is only honest when the allergen guard is what cut. For a
        // price or promo cut it would answer a question the guest never asked.
        const allergenCut = warnings.includes("ungrounded_allergen_assurance_removed");
        return {
          text: allergenCut ? allergenUnverifiedText(ctx) : fallback(ctx),
          hasLink: false,
          warnings,
        };
      }
    }
  }

  // A hard three-sentence cut amputated real answers mid-thought ("here are the
  // options, the price is X" lost the closing question). Brevity now belongs to
  // the prompt; the validator only stops genuine runaway output.
  const REPLY_MAX_SENTENCES = 5;
  const REPLY_MAX_CHARS = 600;
  if (sentenceCount(text) > REPLY_MAX_SENTENCES || textWithoutUrls(text).length > REPLY_MAX_CHARS) {
    text = enforceMaxSentences(text, REPLY_MAX_SENTENCES);
    warnings.push("reply_length_capped");
  }

  return { text: text || fallback(ctx), hasLink: hasLinkInResponse(text), warnings };
}
import {
  isManualOrderCancellationClaim,
  isManualOrderHandlingClaim,
  manualCancellationBoundaryText,
} from "../services/orderAuthority.service.js";

function mixedMenuAvailabilityReply(ctx:FastFoodContext,toolsCalled:string[]):string|null {
 const current=String(ctx.text||"").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu,"");
 if(!/(?:что\s+(?:есть|доступно)|какие\s+(?:блюда|позиции)|не\s+бар(?:ын)?|қандай\s+(?:тағам|ас))/iu.test(current)
   || /не\s+(?:нужно|надо|показыв\p{L}*|рассказыв\p{L}*)|мәзір\p{L}*[^.!?]{0,20}(?:керек\s+емес|қажет\s+емес)/iu.test(current))return null;
 const snapshot=ctx.menuSnapshot, catalog=ctx.menuGrounding;
 const unknown=ctx.language==="kk"?"Мәзірде не қолжетімді екенін қазір растай алмаймын.":"Что сейчас доступно в меню, подтвердить не могу.";
 // Operational runtime staleness does not invalidate independently current menu facts.
 const catalogStale=Boolean(catalog?.stale||catalog?.is_stale||catalog?.stale_menu_backup
   ||/stale|backup|fallback/.test(String(catalog?.source||""))||/stale|backup|fallback/.test(String(snapshot?.source||"")));
 if(!snapshot||snapshot.source==="menu_unavailable"||catalog?.menu_lookup==="unavailable"||catalog?.error||catalogStale
   ||(!catalog&&!toolsCalled.includes("searchMenu"))||!Array.isArray(ctx.activeShiftNotes))return unknown;
 const items=Array.isArray(catalog?.items)&&catalog.items.length?catalog.items:snapshot.items;
 if(!Array.isArray(items))return unknown;
 const blocked=[...(catalog?.unavailable_now||[]),...(catalog?.sold_out_now||[])];
 const vocabulary=menuVocabulary(items);
 const names=eligibleShoppingItems(ctx,items).filter((item:any)=>item?.available===true&&typeof item.name==="string"&&item.name.trim()
   &&!menuItemBlockedByNotes(ctx.activeShiftNotes,item,vocabulary).blocked
   &&!blocked.some((entry:any)=>menuClaimKey(entry?.name??entry)===menuClaimKey(item.name)))
   .slice(0,4).map((item:any)=>item.name.trim().replace(/\s+/g," "));
 if(!names.length)return unknown;
 return ctx.language==="kk"?"Қазіргі мәзірде қолжетімді деп көрсетілген: "+names.join("; ")+".":"В текущем каталоге отмечены доступными: "+names.join("; ")+".";
}
/** A failed language rewrite retains verified facts and current expressed intent. */
export function groundedReplyFallback(ctx:FastFoodContext,toolsCalled:string[]=[],runtime:any=null,linkOutcome:any=undefined):string|null {
 const current=String(ctx.text||"").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu,"");
 const consent=detectKitchenConsentAnswer(current)==="yes"&&/(?:ждать|подожд|күт\p{L}*)/iu.test(current)
   &&!/(?:не\s+соглас\p{L}*|не\s+готов\p{L}*|(?:күтуге|күтемін)[^.!?]{0,20}(?:емес|жоқ)|күтпеймін)/iu.test(current);
 if(!consent&&!/(?:сколько\s+ждать|как\s+долго|қанша\s+күту|күту\s+уақыты)/iu.test(current))return null;
 const unknown=ctx.language==="kk"?"Күту уақытын қазір растай алмаймын.":"Время ожидания сейчас подтвердить не могу.";
 let wait=unknown;
 if(toolsCalled.includes("getKitchenStatus")&&runtime?.runtime_available===true&&runtime.live===true&&runtime.is_last_known!==true
   &&!runtime.stale_runtime_backup&&!runtime.redis_runtime_fallback&&!/backup|stale|fallback/.test(String(runtime.source||""))){
  const raw=runtime.wait_time??runtime.kitchen_status?.wait_time;const minutes=Number(raw);
  if(raw!==null&&raw!==undefined&&Number.isFinite(minutes)&&minutes>=0&&minutes<=1440)
   wait=ctx.language==="kk"?"Қазіргі шамамен күту уақыты — "+minutes+" минут.":"Сейчас ориентировочное ожидание — "+minutes+" минут.";
 }
 if(!consent)return wait;
 const acknowledged=ctx.language==="kk"?"Күтуге дайын екеніңізді түсіндім.":"Понимаю вашу готовность ждать.";
 const granted=linkOutcome?.allowed===true&&ctx.magicLinkGranted===true&&Boolean(ctx.magicLink)&&typeof linkOutcome.link==="string"&&linkOutcome.link===ctx.magicLink;
 const next=granted
  ?ctx.language==="kk"?"Рәсімдеу сілтемесі бөлек хабарламамен жіберіледі.":"Ссылка для оформления будет отправлена отдельным сообщением."
  :ctx.language==="kk"?"Рәсімдеу сілтемесін қазір растай алмаймын. Тапсырысты жалғастырғыңыз келсе, сілтемені сұраңыз.":"Ссылку для оформления сейчас подтвердить не могу. Если хотите продолжить оформление, попросите ссылку.";
 return acknowledged+" "+wait+" "+next;
}
export { fallbackReply };

// «Сілтеме чатымызда сәл жоғарыда тұр» / «посмотрите выше» - live 2026-10-04 the guest
// asked twice for the link and was sent up the chat twice. When the guest asked for the
// link (or the tool granted it this turn), such a sentence is cut.
const LINK_SCROLL_UP_RE =
  /(жоғары(?:да|ға|рақ)?|жогары(?:да|га)?|выше|бұған\s*дейін\s*жіберіл|бурын\s*жибери|бұрын\s*жіберіл|алдында\s*жіберіл|уже\s*(?:отправ|скинул|присыл|был)|ранее\s*(?:отправ|присыл)|already\s*sent|scroll\s*up|пролистай|листа(?:йте|ть))/iu;
const LINK_WORD_RE = /(сілтеме|силтеме|ссылк|линк|link|мәзір|мазир|меню)/iu;

export function stripLinkScrollUpSentences(text: string, ctx: any): { text: string; changed: string | null } {
  const value = String(text || "");
  if (!(ctx?.magicLinkGranted === true || ctx?.explicitMenuLinkIntent === true)) return { text: value, changed: null };
  if (!LINK_SCROLL_UP_RE.test(value)) return { text: value, changed: null };
  const sentences = value.split(/(?<=[.!?\u2026])\s+|\n+/);
  const kept = sentences.filter((sentence) => !(LINK_SCROLL_UP_RE.test(sentence) && LINK_WORD_RE.test(sentence)));
  if (kept.length === sentences.length) return { text: value, changed: null };
  const joined = kept.join(" ").replace(/\s{2,}/g, " ").trim();
  if (joined) return { text: joined, changed: "link_scroll_up_removed" };
  const kk = ctx?.language === "kk";
  const replacement = ctx?.magicLinkGranted === true
    ? (kk ? "Әрине, мінекей сілтеме, мархабат!" : "Конечно, дублирую ссылку для вас!")
    : (kk ? "Әрине, қазір сілтемені қайта жіберемін." : "Конечно, сейчас продублирую ссылку.");
  return { text: replacement, changed: "link_scroll_up_replaced" };
}

const GENERIC_VOICE_HELP_RE =
  /^(?:с[әа]лем(?:етсіз\s*бе)?|салам|здравствуйте|привет)[!,.\s😊🙂]*(?:не\s*болмаса[,\s]*)?(?:не|қандай)?\s*(?:көмек\s*керек|жаза\s*бер|чем\s+помочь|напишите)/iu;

function replaceGenericVoiceGreeting(text: string, ctx: FastFoodContext) {
  if (!isVoiceContext(ctx) || readGuestGreeting(String(ctx.text || ""))?.pure) return null;
  if (String(text || "").length > 150 || !GENERIC_VOICE_HELP_RE.test(String(text || ""))) return null;
  return ctx.language === "ru"
    ? "Не полностью разобрал голосовой вопрос. Повторите, пожалуйста, коротко ещё раз."
    : "Дауыстық сұрағыңызды толық түсінбедім. Бір рет қысқаша қайталап айтыңызшы.";
}

function isVoiceContext(ctx: FastFoodContext) {
  const media: any = ctx?.mediaContext || null;
  return Boolean(media && /audio|voice|ptt/i.test(String(media.kind || media.type || media.mimeType || "")));
}

function catalogAlternativesBlocked(ctx: FastFoodContext): boolean {
  const policy = classifyKitchenSalesPolicyForContext(ctx.runtimeStatus || ctx.hardRealtimeContext, ctx.activeShiftNotes);
  if (policy.blocksAllSales && policy.mode !== "off_hours"
    || policy.requiresConsent && ctx.kitchenCheckoutFingerprint !== policy.fingerprint) return true;
  const current = String(ctx.text || "");
  return isExplicitHumanOperatorRequest(current) || isExplicitCourierContactRequest(current)
    || isCurrentComplaintRequest(current) || isLikelyComplaintText(current) && complaintHasActionableDetail(current);
}

function boundedBudgetAlternatives(ctx: FastFoodContext, toolsCalled: string[] = [], draft = ""): string | null {
  if (catalogAlternativesBlocked(ctx)) return null;
  const shopping = shoppingConstraintsForContext(ctx);
  const budget = shopping.budget;
  const basket = shoppingBasketQuote(ctx);
  if (basket && !ctx.shoppingPriorStateUnknown && !shopping.uncertainBudget) {
    const lines = basket.lines.map(line => line.quantity+" × "+line.name+" ("+line.unit_price+" тг)").join("; ");
    const comparison = basket.budget === null ? "" : ctx.language === "kk"
      ? (basket.fits ? " "+basket.budget+" тг бюджет шегінде." : " "+basket.budget+" тг бюджеттен асады.")
      : (basket.fits ? " В пределах бюджета "+basket.budget+" тг." : " Превышает бюджет "+basket.budget+" тг.");
    return ctx.language === "kk" ? lines+": барлығы "+basket.total+" тг."+comparison+" Жеткізу құны бұл сомаға кірмейді."
      : lines+": всего "+basket.total+" тг."+comparison+" Стоимость доставки в сумму не включена.";
  }
  if (!isShoppingDecision(ctx)) return null;
  if (ctx.shoppingPriorStateUnknown || ctx.shoppingStateUnavailable && budget === null && !shopping.avoidMeat) return ctx.language === "kk" ? "Алдыңғы шектеулеріңізді растай алмаймын. Бюджет пен тағам шектеулерін нақтылай аласыз ба?" : "Не могу подтвердить прежние ограничения. Уточните бюджет и ограничения по еде.";
  const qualitativeCheap = isQualitativeMenuBudgetInquiry(ctx.text);
  if (budget === null && !shopping.avoidMeat && !shopping.uncertainBudget && !qualitativeCheap) return null;
  if (shopping.uncertainBudget && !qualitativeCheap) return ctx.language === "kk" ? "Бюджет сомасын нақтылай аласыз ба?" : "Уточните, пожалуйста, сумму бюджета.";
  const current = String(ctx.text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  // A budget answer must not replace another current requested answer/action.
  const requestedAction = current.replace(/(?<!\p{L})бас[қк]а\s+а[қк]шам?\s+жо[қк](?!\p{L})/giu, "");
  if (/(?:оператор|админ|жалоб|шағым|шагым|отрав|ақша|акша|возврат|вернит|оплат|төлем|толем|чек|кухн|асүй|ас\s?үй)/iu.test(requestedAction)) return null;
  if (/(?<!\p{L})закажи(?:те)?(?!\p{L})|(?:тапсырыс|заказ)\p{L}*\s+(?:жаса|бер)(?:ңыз|ныз|іңіз|иниз|ңдар|ндар|іңдер|индер)?(?!\p{L})/iu.test(current)) return null;
  // Generic pre-order exploration can need budget advice; specific order actions keep their own flow.
  if (isCustomerOrderStatusQuestion(current)
    || /(?:оформ\p{L}*|созда\p{L}*|измен\p{L}*|отмен\p{L}*|добав\p{L}*|удал\p{L}*)[^.!?]{0,40}(?:заказ|тапсырыс)|(?:заказ|тапсырыс)\p{L}*[^.!?]{0,40}(?:оформ|созда|измен|отмен|рәсімде|расимде|өзгерт|озгерт|болдырма|жой|жасаңыз|жасаныз|беріңіз|бериниз)/iu.test(current)) return null;
  // A category preference narrows fallback snapshots when an older caller did
  // not attach the scoped search result. Live search grounding remains primary.
  const beveragesOnly = /(?:напит\p{L}*|попить|пить|сусын\p{L}*|ішетін|ишетин)/iu.test(current);
  const nearestUser = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : []).slice(-6)
    .filter((row: any) => row?.role === "user")
    .map((row: any) => String(row.content ?? row.text ?? "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, ""))
    .filter((value: string) => value.trim() && value.trim() !== current.trim()).slice(-1)[0] || "";
  // Price alone cannot satisfy health/diet constraints. Preserve their safety answer.
  if (ALLERGY_TOPIC_RE.test(current) || ALLERGY_TOPIC_RE.test(nearestUser)
    || [current, nearestUser].some(value => /вегетари|веган|халал|диет|без[^.!?]{0,20}(?:молока|яиц|глютена)|сүтсіз/iu.test(value))) return null;
  const unknown = ctx.language === "kk"
    ? "Шектеулеріңізге сай нұсқаларды қазір растай алмаймын."
    : "Сейчас не могу подтвердить варианты с учётом ваших ограничений.";
  const snapshot = ctx.menuSnapshot;
  const grounding = ctx.menuGrounding;
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.source === "menu_unavailable"
    || grounding?.menu_lookup === "unavailable" || grounding?.error
    || (!grounding && !toolsCalled.includes("searchMenu"))) return unknown;
  const hasScopedGrounding = toolsCalled.includes("searchMenu") && grounding && Array.isArray(grounding.items)
    && Object.prototype.hasOwnProperty.call(grounding, "lookup_query");
  const groundedCategoryItems = hasScopedGrounding ? grounding.items
    : grounding?.category_browse && Array.isArray(grounding.items) ? grounding.items : snapshot.items;
  const vocabulary = menuVocabulary(snapshot.items);
  const blockedNow = new Set([...(grounding?.unavailable_now || []), ...(grounding?.sold_out_now || [])]
    .map((entry: any) => menuClaimKey(entry?.name ?? entry)).filter(Boolean));
  const priced = eligibleShoppingItems(ctx, groundedCategoryItems).filter((item: any) => item && item.available !== false
    && !blockedNow.has(menuClaimKey(item.name))
    && typeof item.name === "string" && item.name.trim()
    && !menuItemBlockedByNotes(ctx.activeShiftNotes || [], item, vocabulary).blocked)
    .map((item: any) => ({item, price: typeof item.price === "number" ? item.price
      : typeof item.price === "string" && /^\d+(?:[.,]\d+)?$/.test(item.price.trim()) ? Number(item.price.trim().replace(",", ".")) : NaN}))
    .filter(({price}: any) => Number.isFinite(price) && price > 0);
  const honestUnknown = /^(?:подтвердить\s+(?:подходящий\s+вариант|состав)\s+(?:пока\s+)?не\s+могу|(?:сейчас\s+)?не\s+могу\s+подтвердить\s+(?:подходящий\s+вариант|состав))[.!?]?$/iu.test(draft.trim());
  if (!priced.length && shopping.avoidMeat && honestUnknown) return null;
  if (!priced.length && shopping.avoidMeat) return ctx.language === "kk"
    ? "Құрамы туралы қазіргі деректерден етсіз лайық нұсқаны растай алмаймын."
    : "По текущим данным о составе не могу подтвердить подходящий вариант без мяса.";
  if (!priced.length) return ctx.language === "kk" ? "Қазіргі мәзірде шектеулеріңізге сай расталған нұсқа табылмады." : "В текущем меню нет подтверждённого варианта с учётом ваших ограничений.";
  const choices = priced.filter(({item, price}: any) => (budget === null || price <= budget)
    && (!beveragesOnly || /(?:напит\p{L}*|сусын\p{L}*|сок|шырын|спрайт|кола|фанта|вода|су(?:\s|$)|чай|шай|кофе)/iu.test(
      String(item.category_name || item.category || "") + " " + String(item.name || ""),
    )))
    .sort((a: any, b: any) => qualitativeCheap ? a.price - b.price : b.price - a.price)
    .slice(0, 3);
  if (!choices.length) return ctx.language === "kk"
    ? `Бағасы расталған қолжетімді нұсқалардан ${budget} тг бюджетке сай келетінін таппадым.`
    : `Среди доступных позиций с подтверждённой ценой не нашёл варианта в пределах ${budget} тг.`;
  const lines = choices.map(({item,price}: any) => `${item.name.trim()} — ${price} тг`).join("; ");
  return ctx.language === "kk"
    ? `${budget === null ? "Шектеулеріңізге сай" : budget + " тг шегінде"} әрқайсысын бөлек таңдауға болады: ${lines}.`
    : `${budget === null ? "С учётом ваших ограничений" : "В пределах " + budget + " тг"} можно выбрать каждый вариант отдельно: ${lines}.`;
}



/** Replace only catalog recommendation clauses while preserving independently
 * grounded answers from other tools in a multi-intent turn. */
function mergeGroundedMenuAnswer(draft: string, menuAnswer: string, ctx: FastFoodContext, toolsCalled: string[] = []): string {
  const urls = draft.match(/https?:\/\/[^\s<>]+/giu) || [];
  const factTools = new Set(["getBusinessInfo", "checkOrderStatus", "getKitchenStatus", "getPaymentDetails", "getShiftNotes", "escalateToAdmin"]);
  const hasIndependentGrounding = toolsCalled.some((tool) => factTools.has(tool));
  if (!hasIndependentGrounding) return [menuAnswer, ...urls].filter(Boolean).join(" ");
  const catalogTerms: string[] = [...new Set<string>((ctx.menuSnapshot?.items || []).flatMap((item: any) => [
    String(item?.name || item?.title || "").trim(),
    String(item?.category_name || item?.category || "").trim(),
  ]).filter(Boolean))].sort((a, b) => b.length - a.length);
  const isMenuClause = (clause: string) => {
    const visible = clause.replace(/https?:\/\/[^\s<>]+/giu, "").trim();
    if (!visible) return true;
    const words = visible.match(/[\p{L}\p{N}-]{3,}/gu) || [];
    const catalogReference = catalogTerms.some((term) => {
      const termWords = term.match(/[\p{L}\p{N}-]{3,}/gu) || [];
      return termWords.length && termWords.every((termWord) =>
        words.some((word) => menuLexemesRelated(termWord, word)));
    });
    return catalogReference
      || /\d[\d ]*\s*(?:тг|тенге|теңге|₸|kzt)(?!\p{L})/iu.test(visible)
      || /(?:в\s+пределах|бюджет\p{L}*|шегінде|выбрать|нұсқа\p{L}*|вариант\p{L}*|позици\p{L}*|блюд\p{L}*|тағам\p{L}*)/iu.test(visible);
  };
  const withoutUrls = draft.replace(/https?:\/\/[^\s<>]+/giu, " ");
  const preserved = (withoutUrls.match(/[^.!?\n]+[.!?]?/gu) || [withoutUrls])
    .map((clause) => clause.trim()).filter((clause) => clause && !isMenuClause(clause));
  return [menuAnswer, ...preserved, ...urls].filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
}

// These public claims must follow this turn's tenant configuration and catalog,
// rather than a default schedule or an old business-side message.
function rewriteCurrentFactClauses(text: string, rewrite: (clause: string) => string | null) {
  const protectedParts: string[] = [];
  const masked = text.replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'|https?:\/\/[^\s<>]+/gu,
    (value) => { protectedParts.push(value); return `\uE000${protectedParts.length - 1}\uE001`; });
  const clauses = masked.split(/(?<=[.!?\n;])\s*|(?<=,)(?!\s*(?:что|будто)(?=$|[^\p{L}]))\s*|\s+(?=(?:но|бірақ|однако|дегенмен|а)\s+)/iu);
  let changed = false;
  const rebuilt = clauses.map((clause) => {
    const unquoted = clause.replace(/\uE000\d+\uE001/gu, '');
    const next = rewrite(unquoted);
    if (next === null) return clause;
    changed = true;
    // Preserve a URL or quotation adjacent to the corrected assertion.
    const protectedSuffix = clause.match(/\uE000\d+\uE001/gu) || [];
    return [next, ...protectedSuffix].filter(Boolean).join(' ');
  }).filter((clause) => clause.trim()).join(' ').trim();
  return {text:changed ? rebuilt.replace(/\uE000(\d+)\uE001/gu, (_, index) => protectedParts[Number(index)]) : text, changed};
}

function nonCurrentFactAssertion(clause: string) {
  return /\?/u.test(clause)
    || /(?<!\p{L})(?:раньше|ранее|вчера|бұрын|кеше)(?!\p{L})/iu.test(clause)
    || /(?:не\s+(?:могу|можем)\s+(?:подтвердить|утверждать|сказать)|не\s+(?:говорю|утверждаю))\s*,?\s*что/iu.test(clause)
    || /(?:подтвердить\s+не\s+могу|растай\s+алмай\p{L}*|айта\s+алмай\p{L}*|нақты\s+айтпай\p{L}*)[.!;,\s]*$/iu.test(clause);
}

function currentWorkHoursClaims(text: string, ctx: FastFoodContext) {
  const hours = String(ctx.config?.work_hours ?? '').trim();
  const range = /(\d{1,2})(?::(\d{2}))?\s*[-–—]\s*(\d{1,2})(?::(\d{2}))?/u.exec(hours);
  const configuredPoints = range ? [Number(range[1]) * 60 + Number(range[2] || 0), Number(range[3]) * 60 + Number(range[4] || 0)] : [];
  const continuous = /24\s*[/:]\s*7|тәулік|круглосут/iu.test(hours)
    || Boolean(range && (configuredPoints[0] === configuredPoints[1] || (configuredPoints[0] === 0 && configuredPoints[1] === 1440)));
  const overnight = continuous || Boolean(range && configuredPoints[1] < configuredPoints[0]);
  const result = rewriteCurrentFactClauses(text, (clause) => {
    if (nonCurrentFactAssertion(clause)) return null;
    const generalNightDenial = /(?:түнде\s+жұмыс\s+істемейміз|ночью\s+не\s+работаем|тек\s+күндізгі\s+уақытта)/iu.test(clause);
    const currentOnly = /(?<!\p{L})(?:қазір|қазіргі\s+уақытта|сейчас|в\s+данный\s+момент)(?!\p{L})/iu.test(clause);
    const scheduledClock = /(?<!\d)\d{1,2}:\d{2}(?!\d)|(?<!\d)\d{1,2}\s*[-–]\s*\d{1,2}(?!\d)|(?:сағат\s+|(?<!\p{L})(?:с|в)\s+)\d{1,2}(?!\d)/u.test(clause)
      && /жұмыс|істейміз|қызмет\s+көрсет|ашыл|жабыл|работ|открыва|откро|закрыва/iu.test(clause);
    const openingForecast = /ашыл|открыва|откро/iu.test(clause)
      && /бүгін|ертең|таңертең|завтра|сегодня|утром/iu.test(clause);
    // Compare minutes, rather than spelling: 03:00, 3:00 and hour-only
    // ranges can express the same configured day or overnight schedule.
    let claimedPoints = [...clause.matchAll(/(?<!\d)(\d{1,2}):(\d{2})(?!\d)/gu)]
      .map((match) => Number(match[1]) * 60 + Number(match[2]));
    if (!claimedPoints.length) {
      const pair = /(?<!\d)(\d{1,2})\s*(?:[-–—]|до|-(?:ден|тен|дан|тан))\s*(\d{1,2})(?!\d)/iu.exec(clause);
      claimedPoints = pair ? [Number(pair[1]) * 60, Number(pair[2]) * 60]
        : [...clause.matchAll(/(?:сағат\s+|(?<!\p{L})(?:с|в|до)\s+)(\d{1,2})(?!\d)/giu)].map((match) => Number(match[1]) * 60);
    }
    const claimedContinuous = claimedPoints.length === 2
      && (claimedPoints[0] === claimedPoints[1] || (claimedPoints[0] === 0 && claimedPoints[1] === 1440));
    const matchingPoints = continuous ? claimedContinuous
      : claimedPoints.length === 2 ? claimedPoints.every((point, index) => point === configuredPoints[index])
        : claimedPoints.length === 1 && (/ашыл|открыва|откро/iu.test(clause) ? claimedPoints[0] === configuredPoints[0]
          : /жабыл|закрыва/iu.test(clause) ? claimedPoints[0] === configuredPoints[1] : configuredPoints.includes(claimedPoints[0]));
    const contradictorySchedule = scheduledClock && Boolean(range || continuous) && claimedPoints.length > 0 && !matchingPoints;
    return ((!hours && (scheduledClock || openingForecast)) || contradictorySchedule
      || (generalNightDenial && !(currentOnly && (ctx.runtimeStatus?.within_work_hours === false || ctx.runtimeStatus?.is_accepting_orders === false)) && (!hours || overnight))) ? '' : null;
  });
  if (result.changed && !result.text) result.text = ctx.language === 'kk'
    ? 'Нақты жұмыс кестесін растай алмаймын.' : 'Не могу подтвердить точные рабочие часы.';
  return result;
}

function currentCatalogAvailabilityClaims(text: string, ctx: FastFoodContext) {
  // Absence of available:false is not proof of available:true. Failed/stale
  // reads likewise cannot turn an old refusal into a positive inventory claim.
  if (!ctx.menuGrounding || ctx.menuGrounding.menu_lookup === 'unavailable'
    || ctx.menuSnapshot?.source === 'menu_unavailable' || ctx.hardRealtimeContext?.stale
    || ctx.runtimeStatus?.stale || !Array.isArray(ctx.activeShiftNotes)) return {text, changed:false};
  const items = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
  const vocabulary = menuVocabulary(items);
  const blocked = [...(ctx.menuGrounding.unavailable_now || []), ...(ctx.menuGrounding.sold_out_now || [])];
  return rewriteCurrentFactClauses(text, (clause) => {
    if (nonCurrentFactAssertion(clause)) return null;
    const refusal = /қол\s*жетімсіз|қол\s*жетімді\s+емес|недоступ\p{L}*|нет\s+в\s+наличии|жоқ/iu.exec(clause);
    if (!refusal || /^\s*емес/iu.test(clause.slice(refusal.index + refusal[0].length))) return null;
    const prefix = menuClaimKey(clause.slice(0, refusal.index));
    const named = namedMenuItems(ctx, prefix).filter((item) => {
      const name = menuClaimKey(item.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<!\\p{L})${name}(?!\\p{L})`, 'iu').test(prefix);
    }).sort((a, b) => prefix.lastIndexOf(menuClaimKey(b.name)) - prefix.lastIndexOf(menuClaimKey(a.name))
      || menuClaimKey(b.name).length - menuClaimKey(a.name).length);
    const item = named[0];
    const afterName = item ? prefix.slice(prefix.lastIndexOf(menuClaimKey(item.name)) + menuClaimKey(item.name).length).trim() : '';
    // A shorter name is not authority for a distinct variant (e.g. a longer SKU).
    const directSubject = /^(?:(?:қазір|уақытша|қазіргі\s+уақытта|сейчас|временно|в\s+данный\s+момент)\s*)*$/iu.test(afterName);
    if (!item || !directSubject || item.available !== true || menuItemBlockedByNotes(ctx.activeShiftNotes, item, vocabulary).blocked
      || blocked.some((entry: any) => menuClaimKey(entry?.name ?? entry) === menuClaimKey(item.name))) return null;
    const end = /[.!;,]\s*$/u.exec(clause)?.[0].trim() || '.';
    return ctx.language === 'kk' ? `${item.name} мәзірде қолжетімді${end}` : `${item.name} доступна в меню${end}`;
  });
}


function currentStaffEffortClaims(text: string, ctx: FastFoodContext) {
  const result = rewriteCurrentFactClauses(text, (clause) => {
    const past = /(?<!\p{L})(?:раньше|ранее|вчера|бұрын|кеше)(?!\p{L})/iu.test(clause);
    const current = /(?:қазір|сейчас|в\s+данный\s+момент)/iu;
    const addition = /\s+(?:және|и)\s+(?=(?:(?:қазір|сейчас)\s+)?(?:мейрамхана(?:ның)?\s+)?(?:қызметкерлер\p{L}*|сотрудник\p{L}*|персонал|повар\p{L}*|аспаз\p{L}*))/iu.exec(clause);
    const currentAddition = past && addition;
    let claim = clause;
    if (currentAddition && addition) {
      // Keep an honest governor or question over the entire coordinated claim.
      if (nonCurrentFactAssertion(clause.replace(/(?<!\p{L})(?:раньше|ранее|вчера|бұрын|кеше)(?!\p{L})/giu, ''))) return null;
      claim = clause.slice(addition.index + addition[0].length);
      if (nonCurrentFactAssertion(claim)) return null;
    } else if (nonCurrentFactAssertion(clause)) return null;
    // A general policy or aspiration is not an observation of today's staff.
    if (/(?:әдетте|әрдайым|обычно|как\s+правило)/iu.test(claim) && !current.test(claim)) return null;
    const staff = /қызметкерлер\p{L}*|персонал|сотрудник\p{L}*|повар\p{L}*|аспаз\p{L}*/iu.test(claim);
    const effort = /тырысуда|тырысып\s+(?:жатыр|отыр)|стара(?:ется|ются)|ускоря(?:ет|ют)/iu.exec(claim);
    // A progressive verb followed by a past auxiliary or a past reporting
    // verb describes a previous claim, rather than staff effort right now.
    const pastEffort = effort && /^\s+(?:еді|болған|деп\s+(?:айтылды|хабарланды|айтқан|айтты|жазылған))(?=$|[^\p{L}])/iu.test(claim.slice(effort.index + effort[0].length));
    const presentEffort = Boolean(effort && !pastEffort);
    const urgency = /тез\s*(?:арада)?|жедел|быстр(?:о|ее)|как\s+можно\s+скорее|ускор/iu.test(claim);
    if (!(staff && presentEffort && urgency)) return null;
    return currentAddition && addition ? clause.slice(0, addition.index).trim() + '.' : '';
  });
  if (result.changed && !result.text) result.text = ctx.language === 'kk'
    ? 'Нақты дайын болу уақытын растай алмаймын.' : 'Не могу подтвердить точное время готовности.';
  return result;
}

const GENERIC_CLOSING_RE = /(?:^|(?<=\s))(?:(?:Егер\s+)?(?:(?:қосымша|басқа)\s+)?сұра[қғ](?:тар)?ыңыз\s+болса[,\s]+(?:жазыңыз|жаза\s+беріңіз|мен\s+көмектесуге\s+дайынмын)|не\s+көмек\s+керек[,\s]+жаза\s+беріңіз|мен\s+көмектесуге\s+дайынмын|если\s+(?:у\s+вас\s+)?(?:(?:будут|возникнут|есть)\s+)?(?:ещ[её]\s+|дополнительные\s+)?вопросы[,\s]+(?:напишите|пишите|обращайтесь)|обращайтесь[,\s]+если\s+(?:возникнут|будут)\s+вопросы)[.!\s😊🙂]*(?=(?:\s+https?:\/\/[^\s<>]+)*$)/iu;

function dropRepeatedGenericClosing(text: string, ctx: FastFoodContext): string {
  const recentAssistant = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [])
    .slice(-6).filter((row: any) => row?.role === "assistant")
    .map((row: any) => String(row.content ?? row.text ?? "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, ""));
  if (!recentAssistant.some(value => GENERIC_CLOSING_RE.test(value))) return text;
  let result = text;
  for (let i = 0; i < 2; i++) {
    const match = GENERIC_CLOSING_RE.exec(result);
    if (!match) break;
    const prefix = result.slice(0, match.index).trim();
    // Never turn an all-closing reply into an empty response or remove quotations.
    if (!prefix || /[«“"]/.test(result.slice(match.index))) break;
    const punctuation = /^[.!?]/.test(match[0]) ? match[0][0] : "";
    const trailingUrls = result.slice(match.index + match[0].length).trim();
    result = prefix + punctuation + (trailingUrls ? `\n${trailingUrls}` : "");
  }
  return result;
}

function catalogNameMentions(text: string, names: string[]): Array<{ key: string; start: number; end: number }> {
  const hits: Array<{ key: string; start: number; end: number }> = [];
  for (const rawName of names) {
    const name = String(rawName || "").trim();
    if (!name) continue;
    const pattern = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/gu, "\\s+");
    for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, "giu"))) {
      hits.push({ key: menuClaimKey(name), start: match.index!, end: match.index! + match[0].length });
    }
  }
  hits.sort((left, right) => (right.end - right.start) - (left.end - left.start) || left.start - right.start);
  const accepted: typeof hits = [];
  for (const hit of hits) {
    if (accepted.some((other) => hit.start < other.end && hit.end > other.start)) continue;
    accepted.push(hit);
  }
  return accepted.sort((left, right) => left.start - right.start);
}

function replaceCategoryListingClauses(text: string, names: string[], enumeration: string): string {
  const parts = String(text || "").split(/(?<=[.!?])\s+|\n+/u);
  const kept = parts.filter((part) => {
    if (!catalogNameMentions(part, names).length) return true;
    return /недоступ\p{L}*|нет\s+в\s+наличии|қолжетімсіз|қолжетімді\s+емес|жо[қк]|закрыт\p{L}*|жабық|ожидан|күту|оператор|жалоб|шағым|реквизит|оплат|төлем|график|жұмыс\s+уақыт|\?/iu.test(part);
  });
  return [...kept.map((part) => part.trim()).filter(Boolean), enumeration].join(" ").trim();
}

function blockedCatalogOffers(text: string, ctx: FastFoodContext): { text: string; changed: boolean } {
  const snapshot = ctx.menuSnapshot;
  const grounding = ctx.menuGrounding as any;
  if (!snapshot || snapshot.source === "menu_unavailable" || grounding?.menu_lookup === "unavailable"
    || grounding?.error || !Array.isArray(snapshot.items) || !Array.isArray(ctx.activeShiftNotes)) {
    return { text, changed: false };
  }
  const vocabulary = menuVocabulary(snapshot.items);
  const externallyBlocked = new Set(
    [...(grounding?.unavailable_now || []), ...(grounding?.sold_out_now || [])]
      .map((entry: any) => menuClaimKey(entry?.name ?? entry)).filter(Boolean),
  );
  const blocked = snapshot.items.filter((item: any) => item && typeof item.name === "string" && item.name.trim()
    && (item.available === false || externallyBlocked.has(menuClaimKey(item.name))
      || menuItemBlockedByNotes(ctx.activeShiftNotes, item, vocabulary).blocked));
  if (!blocked.length) return { text, changed: false };
  const blockedNames = blocked.map((item: any) => String(item.name).trim());
  const removed = new Set<string>();
  const rewritten = rewriteCurrentFactClauses(text, (clause) => {
    if (nonCurrentFactAssertion(clause) || /[«»“”"]|\?\s*$/u.test(clause)
      || /недоступ\p{L}*|нет\s+в\s+наличии|қолжетімсіз|қолжетімді\s+емес|жо[қк]/iu.test(clause)) return null;
    const mentions = catalogNameMentions(clause, blockedNames);
    if (!mentions.length || !PRICE_CLAIM_RE.test(clause)
      && !/доступ\p{L}*|қолжетімді|(?<!\p{L})есть(?!\p{L})|(?<!\p{L})бар(?!\p{L})|мәзірде\s+бар|рекоменд|совет\p{L}*|ұсынам|кеңес\p{L}*|вариант|попроб\p{L}*|можно\s+(?:взять|выбрать|заказать)|возьм\p{L}*|выбер\p{L}*|закаж\p{L}*|алуға\s+болады|алуга\s+болады|алып\s+көр|сынап\s+көр|таңда\p{L}*|танда\p{L}*/iu.test(clause)) return null;
    for (const mention of mentions) removed.add(mention.key);
    return "";
  });
  if (!rewritten.changed) return { text, changed: false };
  const affected = blockedNames.filter((name) => removed.has(menuClaimKey(name)));
  const allowed = (Array.isArray(grounding?.items) ? grounding.items : [])
    .filter((item: any) => item?.available !== false && typeof item?.name === "string" && item.name.trim()
      && !externallyBlocked.has(menuClaimKey(item.name))
      && !menuItemBlockedByNotes(ctx.activeShiftNotes, item, vocabulary).blocked);
  const alternative = allowed[0];
  const unavailable = ctx.language === "kk"
    ? `Қазір қолжетімсіз: ${affected.join("; ")}.`
    : `Сейчас недоступно: ${affected.join("; ")}.`;
  const alternativeText = alternative
    ? (ctx.language === "kk" ? `Қолжетімді балама: ${alternative.name}${Number.isFinite(Number(alternative.price)) ? ` — ${Number(alternative.price)} тг` : ""}.`
      : `Доступная альтернатива: ${alternative.name}${Number.isFinite(Number(alternative.price)) ? ` — ${Number(alternative.price)} тг` : ""}.`)
    : "";
  return { text: [unavailable, alternativeText, rewritten.text].filter(Boolean).join(" ").trim(), changed: true };
}

function groundedCategoryEnumeration(text: string, ctx: FastFoodContext): string | null {
  const grounding = ctx.menuGrounding as any;
  if (!grounding?.category_browse || grounding.menu_lookup === "unavailable" || grounding.error
    || isMenuBudgetInquiry(ctx.text)) return null;
  if (catalogAlternativesBlocked(ctx)) return null;
  const rawItems = (Array.isArray(grounding.items) ? grounding.items : [])
    .filter((item: any) => item?.available !== false && typeof item?.name === "string" && item.name.trim());
  const byName = new Map<string, { name: string; price: number | null }>();
  for (const item of rawItems) {
    const name = String(item.name).trim();
    const key = menuClaimKey(name);
    if (!key || byName.has(key)) continue;
    const price = typeof item.price === "number" ? item.price
      : typeof item.price === "string" && /^\d+(?:[.,]\d+)?$/.test(item.price.trim()) ? Number(item.price.replace(",", ".")) : null;
    byName.set(key, { name, price });
  }
  const items = [...byName.values()];
  if (items.length < 2) return null;
  const duplicateDelta = Math.max(0, rawItems.length - items.length);
  const total = Math.max(items.length, (Number(grounding.totalMatched) || rawItems.length) - duplicateDelta);
  const targetCount = items.length <= 8 ? items.length : Math.min(5, items.length);
  const covered = new Set(catalogNameMentions(text, items.map((item) => item.name)).map((hit) => hit.key)).size;
  const shownRemaining = Math.max(0, total - targetCount);
  const truthPresent = shownRemaining === 0 || new RegExp(`(?<!\\d)${shownRemaining}(?!\\d)`, "u").test(text);
  if (covered >= targetCount && (items.length > 8 ? truthPresent : covered === items.length)) return null;

  const sample = items.slice(0, targetCount);
  const rendered = sample.map((item) => item.price !== null ? `${item.name} — ${item.price} тг` : item.name).join("; ");
  const remaining = Math.max(0, total - sample.length);
  const tail = remaining > 0
    ? ctx.language === "kk"
      ? (ctx.magicLinkGranted ? `Тағы ${remaining} нұсқа жіберілген мәзір сілтемесінде бар.` : `Тағы ${remaining} нұсқа бар.`)
      : (ctx.magicLinkGranted ? `Ещё ${remaining} вариантов есть в отправленной ссылке на меню.` : `Есть ещё ${remaining} вариантов.`)
    : "";
  const enumeration = [rendered + ".", tail].filter(Boolean).join(" ");
  return replaceCategoryListingClauses(text, items.map((item) => item.name), enumeration);
}

const ORDER_TAKING_COLLECTION_QUESTION_RE = /^(?:(?:қай|қандай)\s+мекенжайға\s+(?:(?:тапсырыс(?:ты)?\s+)?жеткіз\p{L}*(?:\s+керек)?|тапсырыс\s+бересіз)|(?:куда|на\s+какой\s+адрес)\s+(?:вам\s+)?доставить(?:\s+заказ)?|сколько\s+(?:штук|порций|единиц)\s+(?:вам\s+)?(?:нужно|нужны)|неше\s+(?:дана|порция)\s+(?:сізге\s+)?(?:керек|аласыз)|(?:как|каким\s+способом)\s+(?:вы\s+)?будете\s+оплачивать|қалай\s+төлейсіз)\s*\?$/iu;

function isCatalogOrderSelectionQuestion(clause: string, ctx: FastFoodContext): boolean {
  if (!/\?\s*$/u.test(clause)
    || !/(?:аласыз|қалайсыз|таңдайсыз|тапсырыс\s+бересіз|будете\s+заказывать|выберете|хотите\s+заказать)/iu.test(clause)) return false;
  const catalogWords = (Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [])
    .flatMap((item: any) => [
      ...String(item?.name || item?.title || "").match(/[\p{L}\p{N}-]{3,}/gu) || [],
      ...String(item?.category_name || item?.category || "").match(/[\p{L}\p{N}-]{3,}/gu) || [],
    ]);
  const answerWords = clause.match(/[\p{L}\p{N}-]{3,}/gu) || [];
  return catalogWords.some((catalogWord) =>
    answerWords.some((answerWord) => menuLexemesRelated(catalogWord, answerWord)));
}

export function validateFinalText(...args: Parameters<typeof validateFinalTextCore>): ReturnType<typeof validateFinalTextCore> {
  const result = validateFinalTextCore(...args);
  const warnings = [...result.warnings];
  const scrollUp = stripLinkScrollUpSentences(result.text, args[1]);
  if (scrollUp.changed) warnings.push(scrollUp.changed);
  // A link RESEND keeps the owner's own phrasing «Әрине, мінекей сілтеме, мархабат!» /
  // «Конечно, дублирую ссылку!» (owner, 2026-10-04); every other turn still drops it.
  const resendTurn = (args[1] as any)?.magicLinkGranted === true && (args[1] as any)?.magicLinkAlreadySent === true;
  const opener = resendTurn ? { text: scrollUp.text, changed: null as string | null } : stripRoboticOpener(scrollUp.text);
  if (opener.changed) warnings.push(opener.changed);
  const aligned = alignGreetingReply(opener.text, args[1]);
  if (aligned.changed) warnings.push(aligned.changed);
  const voiceReplacement = replaceGenericVoiceGreeting(aligned.text, args[1]);
  if (voiceReplacement) warnings.push("generic_voice_greeting_blocked");
  let finalText = voiceReplacement || aligned.text;
  const budgetReply = boundedBudgetAlternatives(args[1], args[2]?.toolsCalled, finalText);
  if (budgetReply !== null) {
    finalText = mergeGroundedMenuAnswer(finalText, budgetReply, args[1], args[2]?.toolsCalled || []);
    warnings.push("budget_alternatives_grounded");
  }
  if (allergySafetyGuaranteeRequested(args[1]) && !hasHonestSafetyGuaranteeDenial(finalText)) {
    finalText = `${safetyGuaranteeDenialText(args[1])} ${finalText}`.trim();
    warnings.push("missing_allergy_guarantee_denial_added");
  }
  const blockedOffer = blockedCatalogOffers(finalText, args[1]);
  if (blockedOffer.changed) warnings.push("blocked_catalog_offer_removed");
  finalText = blockedOffer.text;
  const categoryEnumeration = budgetReply === null ? groundedCategoryEnumeration(finalText, args[1]) : null;
  if (categoryEnumeration !== null) {
    finalText = categoryEnumeration;
    warnings.push("category_enumeration_grounded");
  }
  const checkoutSelection = guardCheckoutSelection(finalText, args[1], args[2]?.toolsCalled);
  if (checkoutSelection.changed) warnings.push(checkoutSelection.changed);
  finalText = checkoutSelection.text;
  const hoursClaims = currentWorkHoursClaims(finalText, args[1]);
  if (hoursClaims.changed) warnings.push("unsupported_work_hours_claim_removed");
  finalText = hoursClaims.text;
  const availabilityClaims = currentCatalogAvailabilityClaims(finalText, args[1]);
  if (availabilityClaims.changed) warnings.push("stale_catalog_unavailability_corrected");
  finalText = availabilityClaims.text;
  const staffEffort = currentStaffEffortClaims(finalText, args[1]);
  if (staffEffort.changed) warnings.push("unsupported_current_staff_effort_removed");
  finalText = staffEffort.text;
  const withoutClosing = dropRepeatedGenericClosing(finalText, args[1]);
  if (withoutClosing !== finalText) {
    finalText = withoutClosing;
    warnings.push("repeated_generic_closing_removed");
  }
  const withoutMenuSelection = rewriteCurrentFactClauses(finalText, (clause) =>
    (/^(?:что\s+(?:вас\s+интересует|(?:вы\s+)?(?:выберете|хотите\s+выбрать)|вам\s+больше\s+нравится)|(?:а\s+)?какая\s+вам\s+больше\s+нравится|какое\s+(?:блюдо|напиток)(?:\s+или\s+(?:блюдо|напиток))?\s+вас\s+интересует|какую?\s+(?:из\s+них\s+)?(?:вы\s+)?будете\s+заказывать|куда\s+доставить\s+заказ|сколько\s+(?:штук|порций|единиц)\s+(?:вам\s+)?(?:нужно|нужны)|как\s+(?:вы\s+)?будете\s+оплачивать|не\s+қызықтырады|(?:сізге\s+)?қайсысы\s+ұнайды|қай\s+мекенжайға\s+тапсырыс\s+бересіз|[^?]{0,80}қайсы\p{L}*\s+(?:аласыз|қалайсыз|таңдайсыз|тапсырыс\s+бересіз)|қай\s+түрін\s+таңдайсыз|қайсысы\s+көңіліңізден\s+шығады)\s*\?$/iu.test(clause.trim())
      || ORDER_TAKING_COLLECTION_QUESTION_RE.test(clause.trim())
      || isCatalogOrderSelectionQuestion(clause, args[1])) ? "" : null);
  if (withoutMenuSelection.changed) {
    finalText = withoutMenuSelection.text || (args[1].language === "kk"
      ? "Тапсырысты мәзір сілтемесі арқылы рәсімдей аласыз."
      : "Оформить заказ можно по ссылке на меню.");
    warnings.push("menu_selection_question_removed");
  }
  return warnings.length === result.warnings.length && finalText === result.text
    ? result
    : { ...result, text: finalText, warnings };
}

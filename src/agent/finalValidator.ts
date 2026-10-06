import { alignGreetingReply, fallbackReply, readGuestGreeting, stripRoboticOpener } from "./greeting.js";
import type { FastFoodContext } from "../context/types.js";

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
  /(асүй|ас\s?үй|кухн|kitchen)[^.!?\n]{0,40}?(дайын|әзір|жұмыс|ашық|жабық|бос|істе|готов|работа|открыт|закрыт|загружен|busy|closed|open)/iu;
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
const ALLERGEN_NEGATION = "(?:жоқ|жок|болмайды|таза|емес|нет|отсутств|без\\s|бeз\\s|не\\s+содерж|свободн|безопасн|қауіпсіз|кауипсиз)";
const FOOD_SAFETY_ASSURANCE_RE = /(?:блюд|тағам|аллерг|орех|жаңғақ)[^.!?]*(?:безопасн|қауіпсіз)|(?:безопасн|қауіпсіз)[^.!?]*(?:блюд|тағам|аллерг|орех|жаңғақ)/iu;
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

const ACCEPTED_ORDER_CLAIM_RE = /(?:заказ[^.!?]{0,50}(?:принят|подтвержд[её]н|оформлен)|тапсырыс[^.!?]{0,50}(?:қабылдан|расталды|рәсімделді))/iu;
const OPERATOR_NOTIFICATION_CLAIM_RE = /(?:оператор|администратор|әкімш)[^.!?]{0,60}(?:уведомл|извещ[её]н|хабардар|хабарлан|передал|отправил|сообщил)|(?:передал|отправил|сообщил)[^.!?]{0,60}(?:оператор|администратор|әкімш)/iu;
const CONFIRMED_OPERATOR_NOTIFICATION_RE = /(?:оператор|администратор|әкімш)[^.!?]{0,60}(?:уведомл|извещ[её]н|хабардар|хабарлан)/iu;
const CONFIRMED_HUMAN_CONTACT_RE = /(?:оператор|администратор|админ|әкімш|экімш)[^.!?]{0,70}(?:хабарластық|хабарластым|хабарладық|хабарладым|хабар бердім|хабар бердік|байланыстық|байланыстым|уведомил|уведомили|сообщил|сообщили|связался|связались)|(?:хабарластық|хабарластым|хабарладық|хабарладым|хабар бердім|хабар бердік|байланыстық|байланыстым|уведомил|уведомили|сообщил|сообщили|связался|связались)[^.!?]{0,70}(?:оператор|администратор|админ|әкімш|экімш)/iu;
const MANUAL_ORDER_WRITE_CLAIM_RE = /(?:(?:я|мы)\s+(?:уже\s+)?(?:оформил|оформляем|оформлю|принял|приняли|принимаю|подтверждаю|подтвердил)[^.!?]{0,60}заказ|заказ[^.!?]{0,60}(?:оформил|оформлю|принимаю|подтверждаю)|тапсырыс[^.!?]{0,60}(?:рәсімдедім|рәсімдеймін|қабылдадым|қабылдадық|қабылдай\s+аламыз))/iu;
export interface ToolGroundingFindings {
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
    && /(?:ваш[аи]?\s+[^.!?]{1,60}|\p{L}+(?:ңыз|ңіз)\s+)(?:готов[аоы]?|дайын)(?=$|[^\p{L}])/iu.test(sentence);
}

function orderStateClaimMatches(sentence: string, evidence: any, ctx: FastFoodContext): boolean | null {
  const productReady = customerProductReadyClaim(sentence, ctx);
  if (!/(?:заказ|тапсырыс|order)/iu.test(sentence) && !productReady) return null;
  const status = String(evidence?.orderStatus ?? evidence?.status ?? "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  const stage = String(evidence?.orderStage ?? evidence?.stage ?? "").toLowerCase().trim();
  const active = !["cancelled", "canceled", "unknown", ""].includes(status)
    && !["cancelled"].includes(stage);
  if (/(?:доставлен|заверш[её]н|аяқтал|жеткізілді)/iu.test(sentence)) return active && (stage === "completed" || status === "completed");
  if (/(?:готовится|готовим|дайындалып|әзірленіп|дайындалуда)/iu.test(sentence)) return active && (stage === "preparing" || ["paid", "preparing", "cooking"].includes(status));
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

const ACTION_NOT_DONE_RE = /(?:не\s+(?:принят|подтвержд|оформлен|оформил|готов|уведомл|извещ|передал|отправил|сообщил)|(?:қабылдан|хабарлан|хабардар|дайын)[^.!?]{0,15}(?:жоқ|емес))/iu;

function isActionAssertion(value: string, pattern: RegExp | ((sentence: string) => boolean)) {
  const unquoted = value.replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  return (unquoted.match(SENTENCE_RE) || [unquoted])
    .flatMap((sentence) => sentence.split(/[,;]|\s+(?:но|бірақ|однако|зато|а)\s+/iu))
    .some((clause) => (typeof pattern === "function" ? pattern(clause) : new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(clause))
      && !ACTION_NOT_DONE_RE.test(clause));
}

function menuClaimKey(value: unknown) {
  return String(value || "").toLowerCase()
    .replace(/(?:coca[-\s]*cola|кока[-\s]*кол[ауые]|(?<!\p{L})кол[ауые](?!\p{L}))/gu, "кола")
    .replace(/\s+\d+(?:[.,]\d+)?\s*(?:л|l|мл|ml)\s*$/iu, "")
    .replace(/\s+/g, " ").trim();
}

function namedMenuItems(ctx: FastFoodContext, value: string): any[] {
  const lower = menuClaimKey(value);
  return (Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [])
    .filter((item: any) => menuClaimKey(item.name) && lower.includes(menuClaimKey(item.name)));
}

function menuSentencePricesMatch(sentence: string, ctx: FastFoodContext) {
  const amounts = [...sentence.matchAll(/(\d[\d \u00a0]*(?:[.,]\d+)?)\s*(?:₸|тг|тенге|теңге|kzt)/giu)];
  return amounts.every((match) => {
    const prefix = menuClaimKey(sentence.slice(0, match.index));
    const named = namedMenuItems(ctx, prefix).sort((a, b) =>
      prefix.lastIndexOf(menuClaimKey(b.name)) - prefix.lastIndexOf(menuClaimKey(a.name)));
    const requested = namedMenuItems(ctx, ctx.text);
    const anonymousPrefix = prefix.replace(/[^\p{L}]+/gu, " ").trim();
    const anonymousPrice = /^(?:(?:цена|стоимость|стоит|он|она|оно|это|этот|эта|данное|блюдо|позиция|за|штуку|бағасы|тұрады|ол|оның|бұл|осы|тағам)\s*)*$/iu.test(anonymousPrefix);
    const candidates = named.length ? [named[0]] : anonymousPrice && requested.length === 1 ? requested : [];
    if (!candidates.length) return false;
    const amount = Number(match[1].replace(/[ \u00a0]/g, "").replace(",", "."));
    return candidates.some((item) => Number(item.price) === amount
      || (Number(item.compare_at_price || item.old_price) > Number(item.price)
        && Number(item.compare_at_price || item.old_price) === amount));
  });
}

function ingredientKey(word: string) {
  const value = word.toLowerCase();
  const aliases: Array<[RegExp, string]> = [[/^(?:вод|су$)/u, "вода"], [/^(?:сахар|қант|кант)/u, "сахар"],
    [/^(?:куриц|курин|тауық|тауык)/u, "курица"], [/^(?:говяд|сиыр)/u, "говядина"],
    [/^(?:помид|томат|қызанақ)/u, "помидор"], [/^(?:огур|қияр)/u, "огурец"],
    [/^(?:сыр|ірімшік)/u, "сыр"]];
  return aliases.find(([pattern]) => pattern.test(value))?.[1] || value.slice(0, Math.max(3, value.length - 2));
}

function menuCompositionCandidates(sentence: string, ctx: FastFoodContext, claimIndex: number): any[] {
  const prefix = sentence.slice(0, claimIndex);
  const named = namedMenuItems(ctx, prefix);
  if (named.length) return named;
  const words = menuClaimKey(prefix).match(/\p{L}+/gu) || [];
  const inflected = (ctx.menuSnapshot?.items || []).filter((item: any) => {
    const nameWords = menuClaimKey(item.name).match(/\p{L}+/gu) || [];
    return nameWords.length > 1 && nameWords.every((word) => {
      const stem = word.length > 5 ? word.slice(0, Math.max(4, word.length - 3)) : word;
      return words.some((candidate) => candidate.startsWith(stem));
    });
  });
  if (inflected.length) return inflected;
  const requested = namedMenuItems(ctx, ctx.text);
  const reference = prefix.replace(/(?:безглютен|безлактоз|орех|жаңғақ|жангак|арахис|яйц|яиц|жұмыртқа|молок|сүт|кунжут|күнжіт|соев|соя|глютен|лактоз)\p{L}*/giu, "")
    .replace(/[^\p{L}]+/gu, " ").trim();
  const anonymous = /^(?:(?:в|у|этом|этой|этого|блюде|блюда|оно|он|она|его|её|состав|составе|это|данном|оның|онда|бұл|осы|тағам|тағамда|тағамның|құрамында|құрамы|ол)\s*)*$/iu.test(reference);
  return anonymous && requested.length === 1 ? requested : [];
}

function menuSupportsIngredientClaim(sentence: string, ctx: FastFoodContext) {
  if (isCompositionUncertaintyOnly(sentence)) return true;
  const claim = /(?:содержит|в\s+составе\s*[:—-]?|состав\s*:|құрамында|құрамы\s*[:—-])\s+([^.!?]+)/iu.exec(sentence);
  if (!claim || /(?:не\s*содержит|нет|жоқ|емес)/iu.test(sentence)) return true;
  const candidates = menuCompositionCandidates(sentence, ctx, claim.index);
  const claimed = (claim[1].match(/\p{L}+/gu) || []).filter((word) => !/^(?:и|с|со|в|және|пен|мен|бар|қосылған)$/iu.test(word)).map(ingredientKey);
  return Boolean(candidates.length && claimed.length && candidates.every((item) => {
    const known = (String(item.composition || item.ingredients || "").match(/\p{L}+/gu) || []).map(ingredientKey);
    return claimed.every((word) => known.includes(word));
  }));
}

const COMPOSITION_UNKNOWN_RE = /(?:нет\s*(?:данных|информац|сведени)|не\s*(?:могу|можем)\s*(?:подтверд|провер)|состав[^.!?]*(?:неизвест|не\s*указ|уточня)|құрам[^.!?]*(?:белгісіз|көрсетілмеген|нақтыла)|растай\s*алмай)/iu;
const ALLERGEN_GROUPS = [/орех|жаңғақ|жангак/iu, /арахис/iu, /глютен/iu, /лактоз/iu,
  /яйц|яиц|жұмыртқа/iu, /молок|сүт/iu, /кунжут|күнжіт/iu, /соев|соя/iu,
  /морепродукт|теңіз\s*өнім|тениз\s*оним/iu];

function isCompositionUncertaintyOnly(sentence: string) {
  // A denial talks ABOUT safety; it must not be mistaken for a safety assertion.
  // Check each adversative/coordinate clause so a later assurance stays prohibited.
  const clauses = sentence.replace(/((?:гарантировать|подтвердить)),\s*что\s+/giu, "$1 что ").split(/[,;]|\s+(?:но|бірақ|однако|зато|и|және)\s+/iu);
  const denial = /^(?:(?:кешіріңіз|извините)[,\s]*)?(?:не\s*(?:могу|можем)\s*(?:гарантировать|подтвердить|проверить)[^.!?;]*|(?:гарантировать|подтвердить|проверить)[^.!?;]*не\s*(?:могу|можем)|[^.!?;]*(?:кепілдік\s*бере\s*алмаймын|қауіпсіздігін\s*растай\s*алмаймын))[.!?]?$/iu;
  let uncertainty = false;
  for (const clause of clauses) {
    if (denial.test(clause.trim())) { uncertainty = true; continue; }
    if (COMPOSITION_UNKNOWN_RE.test(clause)) {
      uncertainty = true;
      if (!/содержит|құрамында|безопасн|қауіпсіз|кауипсиз|(?:орех|жаңғақ|арахис|глютен|лактоз)[^.!?]*(?:нет|жоқ|сыз)|нет[^.!?]*(?:орех|жаңғақ|арахис|глютен|лактоз)/iu.test(clause)) continue;
    }
    if (ALLERGEN_ASSURANCE_RE.test(clause) || /содержит|құрамында|безопасн|қауіпсіз|кауипсиз/iu.test(clause)) return false;
  }
  return uncertainty;
}


function menuSupportsAllergenAbsence(sentence: string, ctx: FastFoodContext) {
  if (isCompositionUncertaintyOnly(sentence)) return true;
  if (/безопасн|қауіпсіз|кауипсиз/iu.test(sentence)) return false;
  const absence = new RegExp(ALLERGEN_NEGATION, "iu").exec(sentence);
  const candidates = menuCompositionCandidates(sentence, ctx, absence?.index ?? sentence.length);
  const groups = ALLERGEN_GROUPS.filter((group) => group.test(sentence));
  return Boolean(candidates.length && groups.length && candidates.every((item) => {
    const composition = String(item.composition || item.ingredients || "");
    const sourceStatements = composition.match(new RegExp(ALLERGEN_ASSURANCE_RE.source, "giu")) || [];
    return groups.every((group) => sourceStatements.some((statement) => group.test(statement)
      && !/безопасн|қауіпсіз|кауипсиз/iu.test(statement)));
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
  /[^.!?\n]*(?:тек|только|лишь)[^.!?\n]{0,60}(?:жеткіз|жеткиз|достав|доставля)[^.!?\n]*[.!?]?|[^.!?\n]*(?:жеткіз|жеткиз|достав)[^.!?\n]{0,40}(?:мүмкін емес|мумкин емес|алмаймыз|болмайды|не\s+можем|невозможн|не\s+осуществля)[^.!?\n]{0,40}(?:мекенжай|адрес|көше|улиц|аудан|район)[^.!?\n]*[.!?]?|[^.!?\n]*(?:мекенжай|адрес|көше|улиц|аудан|район)[^.!?\n]{0,50}(?:жеткіз\p{L}*\s*(?:мүмкін емес|алмаймыз|болмайды)|не\s+доставля|вне\s+зоны|аймақтан\s+тыс)[^.!?\n]*[.!?]?/giu;

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
const FUTURE_HUMAN_CONTACT_RE = /(?:^|[^\p{L}])(?:оператор\p{L}*|администратор\p{L}*|әкімш\p{L}*|они|он|она|олар|ол)(?=$|[^\p{L}])[^.!?]{0,80}(?:ответит|ответят|свяжется|свяжутся|подключится|подключатся|жауап\s*береді|байланысады|хабарласады|қосылады)|(?:с\s+вами|вам|сізбен|сізге)[^.!?]{0,60}(?:свяжется|свяжутся|ответят|байланысады|хабарласады|жауап\s*береді)/iu;
const HUMAN_CONTACT_TIME_RE = /(?:вскоре|скоро|в\s+ближайшее\s+время|сразу|немедленно|жақын\s+арада|жақында|тезірек|\d+\s*(?:минут|мин|сағат))/iu;
const KITCHEN_ACTION_RE = /(?:кухн|ас\s*үй|асүй)[^.!?]{0,70}(?:нақтылап|нақтылай|тексеріп)|(?:уточню|уточняю|спрошу|проверю)[^.!?]{0,70}кухн/iu;
function promisedHumanAction(sentence: string, pattern: RegExp) {
  const unquoted = sentence.replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  return unquoted.split(/[,;]|\s+(?:но|бірақ|однако|зато)\s+/iu).some((clause) =>
    pattern.test(clause) && !/(?:не\s*(?:буду|могу|стану|позову|передам|сообщу|уточню|ответит|свяжется|подключится)|(?:хабарлай|жібер|нақтыла)[^.!?]{0,20}(?:алмай|емес|жоқ))/iu.test(clause)
      && !/^\s*(?:если|егер|қажет\s*болса|керек\s*болса)/iu.test(clause));
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
  const urls = uniqueUrls(text);
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return text;
  const sentences = trimmed.match(TERMINATED_SENTENCE_RE);
  const body = !sentences || sentences.length <= max ? trimmed : sentences.slice(0, max).map((sentence) => sentence.trim()).join(" ");
  return [body, ...urls].filter(Boolean).join("\n");
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
    ? "Құрамы мен аллергендері туралы расталған дерек жоқ. Аллергия кезінде қауіпсіз екеніне кепілдік бере алмаймын."
    : "У меня нет подтверждённых данных о составе и аллергенах. Гарантировать безопасность при аллергии не могу.";
}

function allergySafetyGuaranteeRequested(ctx: FastFoodContext) {
  const text = String(ctx.text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
  if (/(?:не\s+(?:прошу|требую|нужна)|без\s+гаранти|кепілдік\s*(?:керек\s*емес|сұрамай|қажет\s*емес))/iu.test(text)) return false;
  const allergenQuestion = /аллерг|орех|арахис|жаңғақ|жангак|глютен|лактоз/iu.test(text);
  return allergenQuestion && /гарантиру(?:ете|ешь|й|йте)|(?:можете|можешь|можно|дай|дайте)[^.!?]{0,70}гарант|гарант[^.!?]{0,60}(?:можете|можешь|даёте|даете)|кепілдік[^.!?]{0,35}(?:бере\s*аласыз|бере\s*аласың|бересіз|бар\s*ма)/iu.test(text);
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

  if (!text) return { text: fallback(ctx), hasLink: false, warnings: [...warnings, "empty_model_output"] };

  const internalError = /TOOL_CHOICE_IGNORED|TEXT_MODEL_TIMEOUT|HEDGE_LOSER_ABORTED|Incident\s+ID|stack\s+trace/iu;
  if (internalError.test(text)) {
    text = dropSentencesMatching(text, internalError);
    warnings.push("internal_error_identifier_removed");
    if (!text) return { text: fallback(ctx), hasLink: false, warnings };
  }

  // Before any other guard: a narrated "Silent Thought: ..." preamble is not part of the
  // answer, and leaving it in front meant every regex below measured the wrong sentence.
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
  const manualWrite = isActionAssertion(text, (sentence) => MANUAL_ORDER_WRITE_CLAIM_RE.test(sentence)
    || isManualOrderHandlingClaim(sentence.replace(ACCEPTED_ORDER_CLAIM_RE, "")));
  if (manualWrite || (!orderEvidence && isActionAssertion(text, ACCEPTED_ORDER_CLAIM_RE))) {
    return {
      text: ctx.language === "kk" ? "Чатта тапсырысты өзім рәсімдей алмаймын. Жаңа тапсырысты сайт арқылы жасай аласыз."
        : "Я не оформляю заказы в чате. Новый заказ можно оформить на сайте.",
      hasLink: false,
      warnings: ["manual_order_claim_blocked"],
    };
  }

  if (!orderEvidence && isActionAssertion(text, (sentence) => customerProductReadyClaim(sentence, ctx))) {
    text = (textWithoutUrls(text).match(SENTENCE_RE) || [text]).filter((sentence) =>
      !isActionAssertion(sentence, (claim) => customerProductReadyClaim(claim, ctx))).join(" ").trim();
    warnings.push("unconfirmed_product_readiness_removed");
    if (!text) return { text: orderStatusUnknownText(ctx), hasLink: false, warnings };
  }

  const wrongState = Boolean(orderEvidence) && isActionAssertion(text, (sentence) => orderStateClaimMatches(sentence, orderEvidence, ctx) === false);
  if (wrongState) {
    const kept = (textWithoutUrls(text).match(SENTENCE_RE) || [text]).filter((sentence) =>
      !isActionAssertion(sentence, (claim) => orderStateClaimMatches(claim, orderEvidence, ctx) === false)).join(" ").trim();
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
    text = (text.match(SENTENCE_RE) || [text]).filter((sentence) => !unverifiedEscalation(sentence)).join(" ").trim();
    PAST_ESCALATION_CLAIM_RE.lastIndex = 0;
    warnings.push("unverified_operator_notification_removed");
    if (!textWithoutUrls(text)) return { text: unverifiedHumanActionText(ctx, caseCreated, notificationAccepted), hasLink: false, warnings };
  }

  const unverifiedHumanAction = (sentence: string) =>
    (!caseCreated && promisedHumanAction(sentence, FUTURE_HUMAN_ACTION_RE))
    || (!notificationAccepted && promisedHumanAction(sentence, FUTURE_HUMAN_CONTACT_RE))
    || (HUMAN_CONTACT_TIME_RE.test(sentence) && promisedHumanAction(sentence, FUTURE_HUMAN_CONTACT_RE))
    || promisedHumanAction(sentence, KITCHEN_ACTION_RE);
  if (unverifiedHumanAction(text)) {
    text = (text.match(SENTENCE_RE) || [text]).filter((sentence) => !unverifiedHumanAction(sentence)).join(" ").trim();
    warnings.push("unverified_human_action_removed");
    if (!textWithoutUrls(text)) return { text: /құрам|состав|орех|жаңғақ|аллерг/iu.test(ctx.text)
      ? allergenUnverifiedText(ctx)
      : unverifiedHumanActionText(ctx, caseCreated, notificationAccepted), hasLink: false, warnings };
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
  if (ctx.language === "ru" && KAZAKH_SPECIFIC_RE.test(text)) {
    warnings.push("possible_kazakh_in_russian_reply");
  }
  if (ctx.language === "kk" && RUSSIAN_SERVICE_WORD_RE.test(text)) {
    warnings.push("possible_russian_in_kazakh_reply");
  }

  // Safety-critical factual guards remain deterministic, but they now cut the
  // offending clause instead of throwing away a whole useful answer. Replacing
  // the entire reply with a canned line is what made the bot feel dead: one
  // stale runtime read turned a good menu answer into "I cannot check that".
  if (!ctx.runtimeStatus || ctx.hardRealtimeContext?.stale) {
    if (KITCHEN_STATUS_RE.test(text)) {
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

  // Ungrounded factual claims: only enforced when the caller reports which
  // tools actually ran this turn. When the report is absent (older callers,
  // unit tests), behavior is byte-identical to before.
  if (grounding && Array.isArray(grounding.toolsCalled)) {
    // The preloaded snapshot is a grounding source, not a hint: menu_snapshot.rule
    // in buildFactsPrompt explicitly authorises selling a listed dish at the price
    // shown. Requiring a tool call on top of that deleted prices the prompt had
    // just told the model to quote - and MENU_LOOKUP_RE does not catch every way a
    // guest asks ("Пицца почем?"), so no tool ran (found 2026-08-22).
    const snapshotPrices = Array.isArray(ctx.menuSnapshot?.items) && ctx.menuSnapshot!.items.length > 0;
    const toolGrounded = grounding.toolsCalled.some((tool) => PRICE_GROUNDING_TOOLS.includes(tool));
    const grounded = snapshotPrices || toolGrounded;
    if (snapshotPrices && PRICE_CLAIM_RE.test(text)
      && (ctx.menuGrounding || !grounding.toolsCalled.some((tool) => tool === "checkOrderStatus" || tool === "getPaymentDetails"))) {
      const checked = dropSentencesMatchingUnless(text, PRICE_CLAIM_RE, (sentence) => menuSentencePricesMatch(sentence, ctx));
      if (checked !== text) {
        warnings.push("menu_price_mismatch_removed");
        text = checked;
        if (!textWithoutUrls(text)) return { text: fallback(ctx), hasLink: false, warnings };
      }
    }
    if (!grounded) {
      if (PRICE_CLAIM_RE.test(text)) {
        const withoutPrices = dropSentencesMatching(text, PRICE_CLAIM_RE);
        if (withoutPrices && withoutPrices !== text) {
          text = withoutPrices;
          warnings.push("ungrounded_price_claim_removed");
        } else {
          warnings.push("ungrounded_price_claim_kept_no_survivor");
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
      const withoutInventedIngredients = dropSentencesMatchingUnless(text, compositionClaim,
        (sentence) => menuSupportsIngredientClaim(sentence, ctx));
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
  if (allergySafetyGuaranteeRequested(args[1]) && !hasHonestSafetyGuaranteeDenial(finalText)) {
    finalText = `${safetyGuaranteeDenialText(args[1])} ${finalText}`.trim();
    warnings.push("missing_allergy_guarantee_denial_added");
  }
  return warnings.length === result.warnings.length && finalText === result.text
    ? result
    : { ...result, text: finalText, warnings };
}

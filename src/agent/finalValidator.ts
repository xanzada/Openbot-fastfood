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
  /[^.!?\n]*\d[\d\s]*(?:тенге|теңге|тг|₸)[^.!?\n]*[.!?]?/iu;
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
const ALLERGEN_TERM = "(?:аллерг|глютен|лактоз|жаңғақ|жангак|орех|теңіз\\s*өнім|тениз\\s*оним|морепродукт|құрам|курам|состав)";
const ALLERGEN_NEGATION = "(?:жоқ|жок|болмайды|таза|емес|нет|отсутств|без\\s|бeз\\s|не\\s+содерж|свободн|безопасн|қауіпсіз|кауипсиз)";
const ALLERGEN_ASSURANCE_RE = new RegExp(
  "[^.!?\\n]*(?:"
    // term ... negation  ("орехов нет", "жаңғақ жоқ", "состав без ...")
    + `${ALLERGEN_TERM}[^.!?\\n]*${ALLERGEN_NEGATION}`
    // negation ... term  ("нет орехов", "не содержит глютена", "безопасно для аллергии")
    + `|${ALLERGEN_NEGATION}[^.!?\\n]*${ALLERGEN_TERM}`
    // single-word assurances that carry no separate negation
    + "|без(?:глютен|лактоз|молочн|ореховы)\\p{L}*"
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
  /[^.!?\n]*(?:бар(?:лық|лик)\s+тағам|бүкіл\s+мәзір|мәзірдегі\s+бар\p{L}*|кез\s*келген\s+тағам|все\s+блюда|всё\s+меню|все\s+меню|любое\s+блюдо|люб\p{L}*\s+из\s+меню|в\s+нашем\s+меню)[^.!?\n]*(?:аллерг|глютен|лактоз|жаңғақ|жангак|орех|теңіз\s*өнім|морепродукт)[^.!?\n]*[.!?]?|[^.!?\n]*(?:аллерг|глютен|лактоз|жаңғақ|жангак|орех|теңіз\s*өнім|морепродукт)[^.!?\n]*(?:бар(?:лық|лик)\s+тағам|бүкіл\s+мәзір|кез\s*келген\s+тағам|все\s+блюда|всё\s+меню|все\s+меню|любое\s+блюдо)[^.!?\n]*[.!?]?|[^.!?\n]*(?:смело\s+выбир\p{L}*|смело\s+заказ\p{L}*|батыл\s+таңда\p{L}*|қорықпай\s+таңда\p{L}*|қорықпай\s+ала\p{L}*)[^.!?\n]*[.!?]?/giu;
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

function textWithoutUrls(text: string): string {
  return String(text || "").replace(URL_RE, " ").replace(/\s{2,}/g, " ").trim();
}

function sentenceCount(text: string): number {
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return 0;
  const sentences = trimmed.match(/[^.!?]*[.!?]+/g);
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
  const sentences = body.match(/[^.!?\n]+[.!?]*/g) || [body];
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

function operatorPromiseBrokenText(language: unknown) {
  return language === "kk"
    ? "Кешіріңіз, өтінішіңізді операторға жібере алмадым - техникалық ақау болып тұр. Біраздан кейін қайта жазып көріңіз немесе бізге қоңырау шалыңыз."
    : "Извините, я не смог передать вашу просьбу оператору - технический сбой. Напишите чуть позже или позвоните нам.";
}

function enforceMaxSentences(text: string, max = 5): string {
  const urls = uniqueUrls(text);
  const trimmed = textWithoutUrls(text);
  if (!trimmed) return text;
  const sentences = trimmed.match(/[^.!?]*[.!?]+/g);
  const body = !sentences || sentences.length <= max ? trimmed : sentences.slice(0, max).map((sentence) => sentence.trim()).join(" ");
  return [body, ...urls].filter(Boolean).join("\n");
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

// The prompt forbids emoji by default, yet the deterministic fallback shipped
// one - so the single most frequently sent sentence contradicted the persona.
function fallback(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Тыңдап тұрмын, не қажет екенін жазыңыз."
    : "Слушаю, напишите, что нужно.";
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
    ? "Қазір қолданыстағы жеңілдік немесе акция туралы нақты айта алмаймын. Тексеріп, оператор нақтылап береді."
    : "Про действующие скидки и акции точно сказать не могу. Уточню у оператора, чтобы не вводить вас в заблуждение.";
}

function allergenUnverifiedText(ctx: FastFoodContext) {
  return ctx.language === "kk"
    ? "Тағамдардың құрамын өзім растай алмаймын. Қандай өнім болмауы керек екенін жазыңыз, асүймен нақтылап, сізге жарайтын тағамдарды айтамын."
    : "Состав блюд подтвердить без кухни не могу. Напишите, какие продукты исключить, я уточню и назову подходящие блюда.";
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

export function validateFinalText(
  rawText: string,
  ctx: FastFoodContext,
  // toolFindings carries what the tools actually RETURNED. A gate that only knows a
  // tool was called cannot tell "the order exists" from "the lookup came back empty",
  // and the model is at its most confident precisely when the lookup failed. When the
  // caller does not report findings the behaviour is unchanged, so older callers and
  // unit tests keep their exact semantics.
  grounding?: { toolsCalled?: string[]; toolFindings?: { orderFound?: boolean; escalationCreated?: boolean } }
): {
  text: string;
  hasLink: boolean;
  warnings: string[];
} {
  let text = stripBotTags(String(rawText || "").trim());
  const warnings: string[] = [];

  if (!text) return { text: fallback(ctx), hasLink: false, warnings: ["empty_model_output"] };

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
  const statusGrounded = statusCalled && orderFound !== false;
  if (!statusGrounded && isManualOrderHandlingClaim(text)) {
    return {
      text: manualOrderBoundaryText(ctx.language),
      hasLink: false,
      warnings: ["manual_order_claim_blocked"],
    };
  }

  // Cancelling is the same boundary in the other direction, and it has no grounding that
  // could make it true: no tool in this agent can change order state. "Жарайды,
  // тапсырысыңызды тоқтатамыз" shipped to a guest who asked to cancel, so they stopped
  // waiting for a cancellation nobody had been asked to perform (found 2026-08-24). The
  // deterministic cancel lane in the webhook does not pass through this validator, so its
  // honest handoff wording is unaffected.
  if (isManualOrderCancellationClaim(text)) {
    return {
      text: manualCancellationBoundaryText(ctx.language),
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

  // A past-tense "the admin has been told" is only allowed when a tool result proves it.
  // Detected here, acted on by the CALLER: the webhook folds this warning into
  // needsAdminEscalation so the promise becomes TRUE - a case is created after all -
  // instead of the validator either lying less loudly or deleting a sentence the routing
  // layer was about to make honest. Callers that never route (unit tests) still get the
  // visible warning.
  PAST_ESCALATION_CLAIM_RE.lastIndex = 0;
  const claimsEscalationDone = PAST_ESCALATION_CLAIM_RE.test(text);
  PAST_ESCALATION_CLAIM_RE.lastIndex = 0;
  if (
    claimsEscalationDone &&
    grounding?.toolFindings?.escalationCreated !== true &&
    !warnings.includes("manual_cancellation_claim_blocked")
  ) {
    warnings.push("escalation_promise_ungrounded");
  }

  // A truncated generation once shipped the single word "Өкі" to a guest. A reply that
  // short with no sentence ending and no URL is a broken fragment, not an answer.
  const looksUnfinished = text.length < 12 && !/[.!?…:]$/.test(text) && !hasLinkInResponse(text);
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
    const withoutOrderClaims = dropSentencesMatching(text, ORDER_STATUS_RE);
    if (withoutOrderClaims) {
      text = withoutOrderClaims;
      warnings.push("unsupported_order_claim_clause_removed");
    } else {
      return { text: noActiveOrderText(ctx), hasLink: false, warnings: [...warnings, "unsupported_order_claim"] };
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
      && (textWithoutUrls(text).match(/[^.!?\n]+[.!?]*/g) || []).some((sentence) =>
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
    const allergenGrounded = grounding.toolsCalled.some((tool) => ALLERGEN_GROUNDING_TOOLS.includes(tool));
    if (!allergenGrounded && ALLERGEN_ASSURANCE_RE.test(text)) {
      const withoutAssurance = dropSentencesMatching(text, ALLERGEN_ASSURANCE_RE);
      text = withoutAssurance;
      warnings.push("ungrounded_allergen_assurance_removed");
      if (!textWithoutUrls(text)) return { text: allergenUnverifiedText(ctx), hasLink: false, warnings };
    }
    // And a blanket claim over the whole menu is cut even WITH the menu read, because no
    // tool result can support it - see BLANKET_ALLERGEN_ASSURANCE_RE.
    BLANKET_ALLERGEN_ASSURANCE_RE.lastIndex = 0;
    if (BLANKET_ALLERGEN_ASSURANCE_RE.test(text)) {
      BLANKET_ALLERGEN_ASSURANCE_RE.lastIndex = 0;
      text = dropSentencesMatching(text, BLANKET_ALLERGEN_ASSURANCE_RE);
      warnings.push("blanket_allergen_assurance_removed");
      if (!textWithoutUrls(text)) return { text: allergenUnverifiedText(ctx), hasLink: false, warnings };
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
  manualOrderBoundaryText,
} from "../services/orderAuthority.service.js";

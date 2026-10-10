import { intentMatches } from "./intentText.js";
import { menuLinkDecisionForTurn, normalizeCheckoutRequestSpelling, wantsMenuAsText } from "./magicLink.js";
import { isMenuBudgetInquiry } from "./menuBudget.js";
import { menuLexemes, menuLexemesRelated } from "./menuQuestionContext.js";
import type { FastFoodContext } from "../context/types.js";

export const DIRECT_ORDER_INTENT_RE =
  /(?:(?:тапсырыс|заказ)\s*(?:бер|жаса|ет|қыл|хочу|оформ|сдел)|(?:алғым\s*келе|аламын|алайын|хочу\s*заказ|хочу\s*взять)|(?:[1-9]|екі|бір|үш|төрт|бес|алты|жеті|сегіз|тоғыз|он|один|два|три|две)\s*(?:пицц|донер|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кол[ау]|порц)|(?:пицц|донер|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кол[ау]).*(?:жасап|әкел|жеткіз|берші|дайында|алғым|аламын|алайын))/iu;

// Keep the finite food noun families distinct so declining cola cannot withdraw
// an independent doner choice, while declensions of the same object do cancel it.
const CURRENT_FOOD_FAMILIES: Array<[string, RegExp]> = [
  ["pizza", /^пицц[ауые](?!\p{L})/iu],
  ["doner", /^донер(?:а|у|ы|ов)?(?!\p{L})/iu],
  ["burger", /^бургер(?:а|у|ы|ов)?(?!\p{L})/iu],
  ["shawarma", /^шаурм[ауые](?!\p{L})/iu],
  ["lavash", /^лаваш(?:а|у|и)?(?!\p{L})/iu],
  ["fries", /^фри(?!\p{L})/iu],
  ["sushi", /^суши(?!\p{L})/iu],
  ["roll", /^ролл(?:а|ы|ов)?(?!\p{L})/iu],
  ["nuggets", /^наггетс(?:ы|ов)?(?!\p{L})/iu],
  ["sandwich", /^сэндвич(?:а|и|ей)?(?!\p{L})/iu],
  ["hotdog", /^хот-?дог(?:а|и|ов)?(?!\p{L})/iu],
  ["cola", /^(?:(?:кока[-\s]*)?кол[ауы]|cola)(?!\p{L})/iu],
  ["sprite", /^(?:спрайт[ау]?|sprite)(?!\p{L})/iu],
  ["fanta", /^(?:фант[ауы]|fanta)(?!\p{L})/iu],
  ["ayran", /^айран[ау]?(?!\p{L})/iu],
  ["caesar", /^цезар(?:ь|я|ю)(?!\p{L})/iu],
  ["combo", /^комбо(?!\p{L})/iu],
];
function currentFoodChoice(clause: string): { family: string; selected: boolean } | null {
  if (/\?/u.test(clause)
    || /(?<!\p{L})(?:если|бы|вчера|раньше|сказал\p{L}*|писал\p{L}*|цитир\p{L}*)(?!\p{L})/iu.test(clause)) return null;
  const match = /^(?:я\s+)?(не\s+)?хочу\s+(?:(?:один|одну|два|две|три|[1-9])\s+)?(.+)/iu.exec(clause.trim());
  if (!match) return null;
  const family = CURRENT_FOOD_FAMILIES.find(([, noun]) => noun.test(match[2]));
  return family ? { family: family[0], selected: !match[1] } : null;
}
function currentFoodChoices(clause: string) {
  // Only adjacent first-person food actions belong to this choice sequence.
  // An intervening reported/informational clause cannot lend its later words
  // to the customer's own action, and the whole conditional/question scope stays.
  if (!currentFoodChoice(clause)) return [];
  const choices: Array<{ family: string; selected: boolean }> = [];
  for (const part of clause.split(/,\s*|\s+и\s+/iu)) {
    const choice = currentFoodChoice(part);
    if (!choice) break;
    choices.push(choice);
  }
  return choices;
}

function currentFoodSelection(value: string) {
  const selected = new Set<string>();
  const otherClauses: string[] = [];
  let sawChoice = false;
  for (const clause of value.split(/(?<=[.!?;])|\n|,\s*но\s+|\s+но\s+/iu)) {
    const choices = currentFoodChoices(clause);
    if (!choices.length) { otherClauses.push(clause); continue; }
    sawChoice = true;
    for (const choice of choices) {
      if (choice.selected) selected.add(choice.family);
      else selected.delete(choice.family);
    }
  }
  return { selected, legacyValue: sawChoice ? otherClauses.join(" ") : value };
}

export function hasDirectOrderIntent(text = ""): boolean {
  const value = String(text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "");
  if (isMenuBudgetInquiry(value)) {
    const independent = value.split(/(?<=[.!?;])|\n|(?<!\p{L})(?:но|бірақ)(?!\p{L})/iu)
      .filter((clause) => !isMenuBudgetInquiry(clause)).join(" ");
    // A budget question is exploratory, but a separate later concrete food
    // choice remains an order decision of its own.
    if (!DIRECT_ORDER_INTENT_RE.test(independent)
      && !/(?:пицц|донер|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кол[ау]).*(?:керек|маған|мне|возьму|аламын|алайын)/iu.test(independent)) return false;
  }
  // Only the observed complete abbreviated choice grants this extra permission.
  if (/^\s*мн\s+колу\s+пж[.!]*\s*$/iu.test(value)) return true;
  const choice = currentFoodSelection(value);
  if (choice.selected.size) return true;
  const legacyValue = choice.legacyValue;
  if (DIRECT_ORDER_INTENT_RE.test(legacyValue)) return true;
  const food = /(?:пицц|донер|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кока[-\s]*кол|кол[ауы]|cola|спрайт|sprite|фанта|fanta|айран|цезар|комбо)/iu;
  return food.test(legacyValue) && /(?:керек|мне|маған|возьму|тогда|дайте|нуж(?:на|ен|ны|но))/iu.test(legacyValue)
    && !/(?:бар\s*ма|есть\s*ли|есть[?!.]*\s*$|қанша|сколько|если|болса|жоқ|нет)/iu.test(legacyValue);
}

// Link permission follows the customer's current request, never model tool arguments.

function catalogChoiceSubjects(items: any[], clause: string): Set<string> {
  const words = menuLexemes(clause);
  const itemMatches: Array<{ key: string; matched: number; total: number; spans: Array<[number, number]> }> = [];
  const categoryKeys = new Set<string>();
  for (const item of items) {
    const name = String(item?.name || item?.title || "").trim();
    const category = String(item?.category_name || item?.category || "").trim();
    const nameTokens = menuLexemes(name);
    const categoryTokens = menuLexemes(category);
    const matched = nameTokens.filter((token) =>
      words.some((word) => menuLexemesRelated(token, word))).length;
    const spans: Array<[number, number]> = [];
    for (let start = 0; nameTokens.length && start + nameTokens.length <= words.length; start += 1) {
      if (nameTokens.every((token, offset) => menuLexemesRelated(token, words[start + offset]))) {
        spans.push([start, start + nameTokens.length - 1]);
      }
    }
    if (name && matched) itemMatches.push({
      key: "item:" + name.toLocaleLowerCase("ru-RU"),
      matched,
      total: nameTokens.length,
      spans,
    });
    if (categoryTokens.length && categoryTokens.every((token) =>
      words.some((word) => menuLexemesRelated(token, word)))) {
      categoryKeys.add("category:" + categoryTokens.join("|"));
    }
  }

  // A longer complete live name suppresses a shorter name only when their text
  // spans overlap. Independent choices of different lengths ("Айран и Пирог
  // Орбита") must both survive; a global longest-name winner loses the first one.
  const complete = itemMatches.filter((match) => match.spans.length > 0);
  if (complete.length) {
    const independent = complete.filter((match) => match.spans.some(([start, end]) =>
      !complete.some((other) => other !== match && other.total > match.total
        && other.spans.some(([outerStart, outerEnd]) => outerStart <= start && outerEnd >= end))));
    return new Set(independent.map((match) => match.key));
  }

  const keys = new Set<string>();
  const greatestOverlap = Math.max(0, ...itemMatches.map((match) => match.matched));
  for (const match of itemMatches) if (match.matched === greatestOverlap) keys.add(match.key);
  for (const key of categoryKeys) keys.add(key);
  return keys;
}

/**
 * Catalog-derived order decision after this turn's live menu lookup.
 * null means the turn has no grounded catalog choice and legacy link intents
 * still decide. false is an authoritative refusal/unavailable choice.
 */
export function currentGroundedCatalogCheckoutDecision(ctx: FastFoodContext): boolean | null {
  const grounding = ctx.menuGrounding as any;
  if (!grounding || !Array.isArray(grounding.items)) return null;
  const catalog = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
  const allowed = grounding.items;
  const allowedKeys = new Set<string>();
  for (const item of allowed) {
    const name = String(item?.name || item?.title || "").trim();
    const category = String(item?.category_name || item?.category || "").trim();
    if (name) allowedKeys.add("item:" + name.toLocaleLowerCase("ru-RU"));
    const categoryTokens = menuLexemes(category);
    if (categoryTokens.length) allowedKeys.add("category:" + categoryTokens.join("|"));
  }
  const categoryMembers = new Map<string, Set<string>>();
  for (const item of catalog) {
    const name = String(item?.name || item?.title || "").trim();
    const categoryTokens = menuLexemes(item?.category_name || item?.category || "");
    if (!name || !categoryTokens.length) continue;
    const categoryKey = "category:" + categoryTokens.join("|");
    const members = categoryMembers.get(categoryKey) || new Set<string>();
    members.add("item:" + name.toLocaleLowerCase("ru-RU"));
    categoryMembers.set(categoryKey, members);
  }
  const lookupTokens = menuLexemes(grounding.lookup_query || "");
  if (allowed.length) allowedKeys.add("grounded:query");
  const visible = String(ctx.text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "");
  const decisions = new Map<string, boolean>();
  let saw = false;
  const clauses = visible.split(/(?<=[.!?;])|\n|(?<!\p{L})(?:потом|затем|но|бірақ)(?!\p{L})|,\s*(?=(?:нет|жоқ|жок|не\s+хочу|хочу))/iu);
  for (const raw of clauses) {
    const clause = raw.trim();
    if (!clause || /(?<!\p{L})(?:если|бы|вчера|кеше|раньше|бұрын|цитир\p{L}*)(?!\p{L})/iu.test(clause)) continue;
    const generalRefusal = /(?:(?:передумал\p{L}*[, ]*)?(?:ничего|ештеңе|ештене)\s+(?:не\s+)?(?:хочу|буду|нужно|надо|керек|қажет|қаламай\p{L}*|алмай\p{L}*)|(?:отмен(?:а|яю|ить)|болдырма)\s*(?:вс[её]|бәрін|барлығын)?)/iu.test(clause);
    if (generalRefusal) {
      decisions.clear();
      decisions.set("grounded:query", false);
      saw = true;
      continue;
    }
    const subjects = catalogChoiceSubjects(catalog, clause);
    const clauseWords = menuLexemes(clause);
    if (!subjects.size && lookupTokens.length && (allowed.length <= 1 || lookupTokens.some((token) =>
      clauseWords.some((word) => menuLexemesRelated(token, word))))) subjects.add("grounded:query");
    if (!subjects.size) continue;
    const refused = /(?:не\s+(?:хочу|буду|нужно|надо)|передумал|отказываюсь|керек\s*емес|қажет\s*емес|қаламай|алмай|бас\s*тарт)/iu.test(clause);
    // A grounded item mention is still only a question when the customer asks
    // for price, composition or availability. In particular, Kazakh "қандай"
    // must not match the unbounded Russian imperative fragment "дай".
    const informational = /[?]|состав|құрам|ингредиент|что\s+входит|ішінде|из\s+чего|қандай|кандай|сколько|қанша|канша|цен|бағ|баг|сто(?:ит|ят)|бар\s*ма|есть\s+ли/iu.test(clause);
    const selected = !refused && !informational && (
      /(?:хочу(?:\s+(?:заказать|взять))?|закажу|возьму|беру|(?<!\p{L})дай(?:те)?(?!\p{L})|нуж(?:ен|на|но|ны)|мне|маған|тогда|онда|керек|алғым\s*кел|алайын|аламын|тапсырыс\s*(?:бер|жаса))/iu.test(clause)
      || /(?:^|[^\p{L}\p{N}])(?:[1-9]\d?|один|одну|два|две|три|бір|екі|үш)\s+\p{L}/iu.test(clause)
    );
    if (!refused && !selected) continue;
    saw = true;
    for (const subject of subjects) {
      decisions.set(subject, selected && allowedKeys.has(subject));
      if (!selected && subject.startsWith("category:")) {
        for (const member of categoryMembers.get(subject) || []) decisions.set(member, false);
      }
    }
  }
  return saw ? [...decisions.values()].some(Boolean) : null;
}

export function hasCustomerCheckoutIntent(text = ""): boolean {
  const value = normalizeCheckoutRequestSpelling(text).replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, "");
  const menuLinkDecision = menuLinkDecisionForTurn(value);
  const explicitOrderActionRe = /(?:хочу\s*(?:заказать|оформить|сделать\s*заказ|заказ|взять)|закажу|заказываю|оформлю|тапсырыс\s*(?:бер(?:ейін|ей|ем|емін|гім)|жас(?:ай|ағым))|алғым\s*келе|аламын|алайын|(?:жасап|дайындап)\s*(?:бер|қой)|дай(?:те)?\s+\d)/iu;
  const explicitLinkRequestRe = /(?:(?<!\p{L})(?:повтор(?:и|ите)|перешл(?:и|ите)|отправ(?:ь|ьте)|пришл(?:и|ите)|покаж(?:и|ите)|откро(?:й|йте)|жібер(?:ші|іңіз|іңдер)?|жибер(?:ші|иниз|ініз|іңіз)?|аш(?:ып\s*бер(?:іңіз|ші)?|ыңыз|шы)?|көрсет(?:ші|іңіз)?|корсет(?:ші|иниз|ініз|іңіз)?)(?!\p{L})\s*(?:(?:мне|нам|пожалуйста|маған|бізге|қазір|қайта)\s*){0,3}(?:меню|мәзір(?:ді|ін|іңізді)?|мазір(?:ді|ін|іңізді)?|каталог(?:ты|ті|а|у)?|корзин(?:у|а|ы)|себет(?:ті|ін|іңізді)?|ссылк(?:у|а|и)|сілтеме(?:ні|ңізді|мізді)?|линк|link)(?!\p{L})|(?<!\p{L})(?:меню|мәзір(?:ді|ін|іңізді)?|мазір(?:ді|ін|іңізді)?|каталог(?:ты|ті|а|у)?|корзин(?:у|а|ы)|себет(?:ті|ін|іңізді)?|ссылк(?:у|а|и)|сілтеме(?:ні|ңізді|мізді)?|линк|link)(?!\p{L})\s*(?:(?:мне|нам|пожалуйста|маған|бізге|қазір|қайта)\s*){0,3}(?:повтор(?:и|ите)|перешл(?:и|ите)|отправ(?:ь|ьте)|пришл(?:и|ите)|покаж(?:и|ите)|откро(?:й|йте)|жібер(?:ші|іңіз|іңдер)?|жибер(?:ші|иниз|ініз|іңіз)?|аш(?:ып\s*бер(?:іңіз|ші)?|ыңыз|шы)?|көрсет(?:ші|іңіз)?|корсет(?:ші|иниз|ініз|іңіз)?)(?!\p{L}))|(?<!\p{L})(?:мәзірді|мазірді|меню|каталогты|себетті|сілтемені)(?!\p{L})\s*(?:және|мен|и)\s+[^.!?]{0,60}(?:көрсет(?:іңіз|ші)?|корсет(?:иниз|ініз|іңіз|ші)?|покаж(?:ите|и)|жібер(?:іңіз|ші)?|жибер(?:иниз|ініз|іңіз|ші)?)(?!\p{L})/iu;
  const explicitLinkNeedRe = /(?:(?<!\p{L})(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)(?!\p{L})\s*(?:(?:маған|мне|нам|бізге)\s*)?(?:керек|қажет|нуж(?:на|ен|ны|но))(?!\p{L})|(?<!\p{L})(?:керек|қажет|нуж(?:на|ен|ны|но))(?!\p{L})\s*(?:(?:маған|мне|нам|бізге)\s*)?(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)(?!\p{L}))/iu;
  const quantityOrPriceQuestionRe = /(?:қанша|канша|қаншадан|каншадан|сколько|сто(?:ит|ят)|цен[аыу]|бағ[аә]|баг[аә]|поч[её]м|покаж|көрсет|корсет|фото|какие|(?<!\p{L})есть(?!\p{L})|бар\s*ма|состав|из\s*чего)/iu;
  if (quantityOrPriceQuestionRe.test(value) && menuLinkDecision !== "allow" && !explicitOrderActionRe.test(value) && !explicitLinkRequestRe.test(value) && !explicitLinkNeedRe.test(value)) return false;
  // A later explicit decision supersedes an earlier request or refusal. Ordinary
  // questions do not create permission, and quoted customer summaries are removed.
  const clauses = value.split(/(?<=[.!?;\n])|(?<!\p{L})(?:но|бірақ)(?!\p{L})|(?:,\s*|(?<!\p{L})(?:и|және)(?!\p{L})\s+)(?=(?:откро\p{L}*|покаж\p{L}*|жібер\p{L}*|жибер\p{L}*|отправ\p{L}*|пришл\p{L}*|(?:себет|корзин|каталог|меню|мәзір|ссылк|сілтеме)\p{L}*[^,;.!?]{0,20}(?:аш|көрсет|корсет|откр|покаж|жібер|жибер|отправ|пришл|керек|қажет|нуж|не\s+нуж)))/iu);
  let decision = false; // Permission independently requested by URL/legacy order action.
  const selectedFoods = new Set<string>();
  for (const clause of clauses) {
    const refusedOrder = /(?:не\s+(?:хочу|буду)\s+(?:(?:сделать|оформить)\s*)?(?:заказ|оформ)|не\s+(?:заказыва|заказал)|тапсырыс\s*(?:керек\s*емес|бермей))/iu.test(clause);
    const refusedLinkRu = /(?:не\s+(?:отправ\p{L}*|присыл\p{L}*|пришл\p{L}*|высыла\p{L}*|скидыва\p{L}*|скинь\p{L}*|откро\p{L}*|покаж\p{L}*|дай(?:те)?)[^.!?]{0,40}(?:меню|каталог|корзин|ссылк|сілтеме)|(?:меню|каталог|корзин\p{L}*|ссылк\p{L}*|сілтеме\p{L}*)[^.!?]{0,40}не\s+(?:отправ\p{L}*|присыл\p{L}*|пришл\p{L}*|высыла\p{L}*|скидыва\p{L}*|скинь\p{L}*|откро\p{L}*|покаж\p{L}*))/iu.test(clause);
    const refusedLinkKk = /(?<!\p{L})(?:жіберме(?:ңіз|ңдер|ші)?|жібермей(?:мін|міз)?|жиберме(?:ніз|ңіз|ндер|ңдер|ші)?|жибермей(?:мін|міз)?|ашпа(?:ңыз|ңдар|шы)?|ашпай(?:мын|мыз)?|көрсетпе(?:ңіз|ңдер|ші)?|көрсетпей(?:мін|міз)?|корсетпе(?:ніз|ңіз|ндер|ңдер|ші)?)(?!\p{L})/iu.test(clause);
    const refusedLinkNeed = /(?:(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url)[^.!?]{0,24}(?:(?:керек|қажет)\s*емес|керегі\s*жоқ|(?<!\p{L})не(?!\p{L})\s*(?:нуж\p{L}*|надо))|(?<!\p{L})не(?!\p{L})\s*(?:нуж\p{L}*|надо)[^.!?]{0,24}(?:сілтеме\p{L}*|ссылк\p{L}*|линк|link|url))/iu.test(clause);
    if (refusedOrder || refusedLinkRu || refusedLinkKk || refusedLinkNeed) { decision = false; selectedFoods.clear(); continue; }
    const budgetInquiry = isMenuBudgetInquiry(clause);
    const explicitOrderAction = !budgetInquiry && explicitOrderActionRe.test(clause);
    const explicitLinkRequest = explicitLinkRequestRe.test(clause) || explicitLinkNeedRe.test(clause);
    if (budgetInquiry && !explicitLinkRequest) continue;
    const foodChoices = budgetInquiry ? [] : currentFoodChoices(clause);
    for (const choice of foodChoices) {
      if (choice.selected) selectedFoods.add(choice.family);
      else selectedFoods.delete(choice.family);
    }
    // Writing the menu here grants no checkout permission by itself. A separate
    // current URL or order request can still accompany the textual menu.
    const explicitUrlRequest = explicitLinkNeedRe.test(clause) || explicitLinkRequestRe.test(clause.replace(/(?<!\p{L})(?:меню|мәзір\p{L}*|мазір\p{L}*|каталог\p{L}*|корзин\p{L}*|себет\p{L}*)(?!\p{L})/giu, ""))
      || /(?<!\p{L})(?:скинь|скиньте|скин|скинте)(?!\p{L})\s*(?:мне\s*|нам\s*|пожалуйста\s*){0,2}(?:ссылк\p{L}*|сілтеме\p{L}*|линк|link)(?!\p{L})/iu.test(clause);
    if (wantsMenuAsText(clause) && !explicitUrlRequest
      && !explicitOrderAction && !hasDirectOrderIntent(clause)) {
      decision = false;
      selectedFoods.clear();
      continue;
    }
    const quantityOrPriceQuestion = quantityOrPriceQuestionRe.test(clause);
    const pastLinkStatement = /(?:отправ(?:ил|ила|или|ляли)|присл(?:ал|ала|али)|высл(?:ал|ала|али)|показа(?:л|ла|ли|ывали)|откр(?:ыл|ыла|ыли)|жібер(?:ді|ген|іпті|дім|дің)|жибер(?:ди|ген)|аш(?:тым|тың|ты|қан|ылды)|көрсет(?:ті|тім|тің|кен))/iu.test(clause);
    if ((quantityOrPriceQuestion && !explicitOrderAction && !explicitLinkRequest)
      || (pastLinkStatement && !explicitOrderAction && !explicitLinkRequest)) continue;
    if (explicitLinkRequest || (!foodChoices.length && hasDirectOrderIntent(clause))
      || /^(?:меню|мәзір|мазір|каталог|ссылка|сілтеме)[?!.,\s]*$/iu.test(clause.trim())
      || /(?:меню|мәзір|мазір|каталог\p{L}*|корзин\p{L}*|себет\p{L}*|ссылк\p{L}*|сілтеме\p{L}*|линк|link)[^.!?]{0,40}(?:жібер|жибер|қайта|скинь|отправ\p{L}*|пришл\p{L}*|открой\p{L}*|покаж\p{L}*|дай|аш|көрсет|не\s*откры|не\s*работ|ашылмай|қарай|посмотреть)/iu.test(clause)
      || /(?:жібер|жибер|скинь|отправ\p{L}*|пришл\p{L}*|открой\p{L}*|покаж\p{L}*|дай|аш|көрсет|повтор|перешли|қайдан\s*қарай|где\s*посмотреть)[^.!?]{0,40}(?:меню|мәзір|мазір|каталог|корзин|себет|ссылк|сілтеме|линк|link)/iu.test(clause)
      || /(?:хочу\s*(?:(?:сделать|оформить)\s*)?(?:заказ|оформ)|(?:где|как)\s*(?:могу\s*)?(?:оформить|сделать)\s*заказ|заказать|(?:заказ|тапсырыс)\s*(?:бер|берей|берем|жаса|хочу|сдел|оформ)|(?:тапсырысты\s*)?жалғастыр|продолж(?:у|им|ить)\s*(?:заказ|оформ))/iu.test(clause)) decision = true;
  }
  if (menuLinkDecision === "deny") return false;
  return menuLinkDecision === "allow" || decision || selectedFoods.size > 0;
}

const ORDER_STATUS_QUESTION_RE =
  /(тапсырысым|заказым|мой\s+заказ|мои\s+заказы|соңғы\s+тапсырыс|последн\p{L}*\s+заказ|order\s+status|тапсырыс.*(?:қайда|кайда|қашан|кашан|дайын|жолда|жеткіз|жеткиз|статус|көрін|корин)|заказ.*(?:где|когда|готов|едет|достав|статус|виден|көрін|корин)|(?:қайда|кайда|қашан|кашан).*(?:тапсырыс|заказ)|(?:где|когда).*(?:заказ|order)|менде.*(?:тапсырыс|заказ).*бар|у\s+меня.*заказ|есть\s+ли.*заказ|статус\s+(?:тапсырыс|заказ|order)|(?:төледім|толедим|оплатил).*(?:тапсырыс|заказ)|(?:тапсырыс|заказ).*(?:төледім|толедим|оплатил))/iu;

const ORDER_NUMBER_RE = /(?:№|#|order\s*|заказ(?:ом|а|у)?\s*|тапсырыс(?:ым|тың|тын)?\s*(?:(?:нөмірі|номері|номер)\s*)?)(\d{1,12})/iu;

const ACTIVE_ORDER_FOLLOW_UP_RE =
  /((?:че|чё|что)\s*там|ну\s*и|и\s*что|не\s*болды|не\s*жаңалық|не\s*жаналык|нестеватсындар|нестеватсыздар|нестеп\s*жатсындар|нестеп\s*жатырсындар|қалай\s*болып\s*жатыр|калай\s*болып\s*жатыр|как\s*там|дайын\s*ба|дайынба|готов(?:о|а)?\s*ли|готов(?:о|а)?|қашан|кашан|когда|скоро\s*ма|скоро|долго\s*(?:ещ[её])?|сколько\s*(?:ещ[её])?|әлі\s*(?:көп\s*пе|қанша\s*күт)|қанша\s*күт|канша\s*кут|жолда\s*ма|жолдама|курьер|едет|келе\s*жатыр\s*ма|келе\s*жатырма|(?:почему|неге)[^.!?]{0,25}(?:не\s*приш|не\s*привез|не\s*достав|келмед|жетпед))/iu;

/** This selects a read of an already scoped active order, never write permission. */
export function activeOrderQuestionKind(text:string, order:unknown):"status"|"readiness"|"payment_confirmation"|"fulfillment"|null {
 if(!order)return null;
 const value=String(text||"").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu,"");
 if(/(?:новый\s+заказ|если\s+закаж|если\s+оформ|жаңа\s+тапсырыс|тапсырыс\s+берсем|кухн|асүй|ас\s+үй|реквизит|kaspi|каспи)/iu.test(value))return null;
 if(/(?:оплат|плат[её]ж|төлем|төлеген|төледім)[^.!?]{0,70}(?:подтвержд|прош[её]л|поступил|растал|жүйеде)|(?:подтвержд|растал)[^.!?]{0,45}(?:оплат|плат[её]ж|төлем)/iu.test(value))return "payment_confirmation";
 if(/(?:доставк[аиу]|жеткізу)[^.!?]{0,55}(?:сам|забер|заби|алып\s+кет|өзім|әлі|әлде)|(?:самовывоз|алып\s+кет)[^.!?]{0,40}(?:или|әлде|жеткізу|достав)/iu.test(value))return "fulfillment";
 if(/(?:он|оно|ол|тапсырыс|заказ)[^.!?]{0,40}(?:готов|дайын\s*(?:болды|ба))|(?:уже\s+готов|готов\s+ли|дайын\s+болды\s+ма)/iu.test(value))return "readiness";
 if(/(?:его|е[её]|оның|онын)[^.!?]{0,25}(?:статус|состояни|күйі|куйі)|(?:статус|күйі)[^.!?]{0,25}(?:сейчас|қазір|какой|қандай)/iu.test(value))return "status";
 return isCustomerOrderStatusQuestion(value)||isLikelyOrderStatusFollowUp(value)?"status":null;
}

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

export function requestedOrderNumber(text = "", history?: unknown): string {
  const value = String(text || "");
  const explicit = value.match(ORDER_NUMBER_RE)?.[1];
  if (explicit) return explicit;
  const bare = value.match(/^\s*(\d{1,12})\s*[.!?]?\s*$/u)?.[1];
  if (!bare || !Array.isArray(history) || !history.length) return "";
  let index = history.length - 1;
  const current = history[index];
  // The persisted history can already include the current inbound user message.
  if (current?.role === "user" && String(current?.text ?? current?.content ?? "").trim() === value.trim()) index -= 1;
  const previous = history[index];
  if (!previous || !["assistant", "model"].includes(String(previous.role))) return "";
  const createdAt = previous.createdAt ?? previous.timestamp ?? previous.created_at;
  if (createdAt != null) {
    const time = typeof createdAt === "number" ? createdAt : Date.parse(String(createdAt));
    const age = Date.now() - time;
    if (!Number.isFinite(time) || age < 0 || age > 30 * 60 * 1000) return "";
  }
  const prompt = String(previous.text ?? previous.content ?? "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "").trim();
  if (!/(?:заказ\p{L}*|тапсырыс\p{L}*)/iu.test(prompt)
    || !/(?:номер\p{L}*|нөмір\p{L}*)/iu.test(prompt)
    || !/(?:пришлите|укажите|напишите|назовите|сообщите|отправьте|жібер\p{L}*|жібере\p{L}*|жазы\p{L}*|айтың\p{L}*|көрсет\p{L}*)/iu.test(prompt)) return "";
  return bare;
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
  if (requestedOrderNumber(value)) return true;
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

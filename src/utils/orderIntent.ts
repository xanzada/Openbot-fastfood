import { intentMatches } from "./intentText.js";
import { menuLinkDecisionForTurn, normalizeCheckoutRequestSpelling, wantsMenuAsText } from "./magicLink.js";
import { isMenuBudgetInquiry } from "./menuBudget.js";
import { catalogNamedItemsInText, menuLexemes, menuLexemesRelated, menuLexemesSameIdentity } from "./menuQuestionContext.js";
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

function catalogSurfaceWords(value: unknown): string[] {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("ru-RU")
    .match(/[\p{L}\p{N}-]+/gu) || [];
}

const CATALOG_DECISION_NOISE_RE = /^(?:а|ал|и|және|мен|я|мы|вы|но|бірақ|хоч\p{L}*|возьм\p{L}*|беру|закаж\p{L}*|заказ\p{L}*|дай(?:те)?|нуж\p{L}*|мне|нам|маған|бізге|тогда|онда|керек|қажет|алғым|кел\p{L}*|алайын|аламын|тапсырыс|бер\p{L}*|жаса\p{L}*|не|нет|жоқ|жок|емес|алмай\p{L}*|қаламай\p{L}*|передумал\p{L}*|отказ\p{L}*|ничего|никак\p{L}*|особенно|әсіресе|тоже|также|ещ[её]|тағы|дағы|да|де|та|те|бір|екі|үш|төрт|бес|один|одну|два|две|три|четыре|пять|сколько|қанша|канша|стоит|цена|баға|бағасы|тг|тенге|теңге|пожалуйста)$/iu;
const CATALOG_OPERATIONAL_MODIFIER_RE = /^(?:сейчас|қазір|казир|қәзір|навынос|самовывоз|әкету)$/iu;
const CATALOG_OPERATIONAL_MODIFIER_PHRASES = [["с", "собой"], ["на", "вынос"], ["алып", "кету"]];

function catalogOperationalModifierIndexes(words: string[]): Set<number> {
  const indexes = new Set<number>();
  words.forEach((word, index) => {
    if (CATALOG_OPERATIONAL_MODIFIER_RE.test(word)) indexes.add(index);
  });
  for (const phrase of CATALOG_OPERATIONAL_MODIFIER_PHRASES) {
    for (let start = 0; start + phrase.length <= words.length; start += 1) {
      if (!phrase.every((word, offset) => words[start + offset] === word)) continue;
      phrase.forEach((_, offset) => indexes.add(start + offset));
    }
  }
  return indexes;
}

function catalogDecisionSubjectWords(clause: string): string[] {
  const words = catalogSurfaceWords(clause);
  const modifierIndexes = catalogOperationalModifierIndexes(words);
  return words.filter((word, index) => !CATALOG_DECISION_NOISE_RE.test(word) && !modifierIndexes.has(index));
}

function normalizeCatalogAliasToken(value: unknown): string {
  return String(value || "").toLocaleLowerCase("ru-RU")
    .replace(/^(?:coca[-\s]*cola|кока[-\s]*кол[ауы]|кол[ауы]|cola)$/iu, "кола")
    .replace(/^(?:sprite|спрайт)$/iu, "спрайт")
    .replace(/^(?:fanta|фанта)$/iu, "фанта");
}

function catalogFieldSupportsWord(field: unknown, word: string): boolean {
  const wordTokens = menuLexemes(word);
  if (!wordTokens.length) return false;
  const fieldTokens = menuLexemes(field);
  const aliasWords = catalogSurfaceWords(field).map(normalizeCatalogAliasToken);
  const normalizedWord = normalizeCatalogAliasToken(word);
  return aliasWords.includes(normalizedWord) || wordTokens.some((token) =>
    fieldTokens.some((fieldToken) => menuLexemesRelated(token, fieldToken)));
}

function catalogItemFields(item: any): unknown[] {
  return [item?.name || item?.title || "", item?.category_name || item?.category || "",
    item?.label || "", item?.composition || "", item?.description || ""];
}

function catalogWordSupported(items: any[], word: string): boolean {
  return items.some((item) => catalogItemFields(item)
    .some((field) => catalogFieldSupportsWord(field, word)));
}

function catalogItemSupportsWords(item: any, words: string[]): boolean {
  const fields = catalogItemFields(item);
  return words.every((word) => fields.some((field) => catalogFieldSupportsWord(field, word)));
}

function catalogWordSupportedByCategory(items: any[], word: string): boolean {
  return items.some((item) => catalogFieldSupportsWord(item?.category_name || item?.category || "", word));
}

const CATALOG_CHOICE_SEPARATOR_RE = /[.!?;]+\s*|\r?\n+|,\s*|\s+(?:и|және|мен)\s+/giu;

type CatalogTextSpan = { start: number; end: number };

function exactCatalogProtectedSpans(items: any[], value: string): CatalogTextSpan[] {
  const wordSpans = [...value.matchAll(/[\p{L}\p{N}-]+/gu)].map((match) => ({
    word: match[0].toLocaleLowerCase("ru-RU"),
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
  const spans: CatalogTextSpan[] = [];
  for (const item of catalogNamedItemsInText(items, value)) {
    const itemWords = catalogSurfaceWords(item?.name || item?.title || "");
    if (!itemWords.length) continue;
    const matches: Array<{ start: number; strict: boolean }> = [];
    for (let start = 0; start + itemWords.length <= wordSpans.length; start += 1) {
      const candidate = wordSpans.slice(start, start + itemWords.length).map((entry) => entry.word);
      if (itemWords.every((word, offset) => menuLexemesSameIdentity(word, candidate[offset]))) {
        matches.push({ start, strict: itemWords.every((word, offset) => word === candidate[offset]) });
      }
    }
    const selected = matches.some((match) => match.strict)
      ? matches.filter((match) => match.strict)
      : matches;
    for (const match of selected) {
      spans.push({
        start: wordSpans[match.start].start,
        end: wordSpans[match.start + itemWords.length - 1].end,
      });
    }
  }
  return spans;
}

function splitCatalogTextOutsideExactSpans(items: any[], value: unknown, separator: RegExp): string[] {
  const source = String(value || "");
  const protectedSpans = exactCatalogProtectedSpans(items, source);
  const groups: string[] = [];
  let cursor = 0;
  for (const match of source.matchAll(separator)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const protectedSeparator = protectedSpans.some((span) => match[0].length
      ? start < span.end && end > span.start
      : start > span.start && start < span.end);
    if (protectedSeparator) continue;
    const group = source.slice(cursor, start).trim();
    if (group) groups.push(group);
    cursor = end;
  }
  const tail = source.slice(cursor).trim();
  if (tail) groups.push(tail);
  return groups.length ? groups : [source.trim()].filter(Boolean);
}

/** Split independent catalog choices while keeping separators inside an exact SKU name protected. */
export function catalogIndependentChoiceGroups(items: any[], value: unknown): string[] {
  return splitCatalogTextOutsideExactSpans(items, value, CATALOG_CHOICE_SEPARATOR_RE);
}

function hasUnresolvedCatalogVariant(items: any[], clause: string, requireCatalogSubject = false): boolean {
  const surfaceWords = catalogSurfaceWords(clause);
  const exactItems = catalogNamedItemsInText(items, clause);
  const independentGroups = catalogIndependentChoiceGroups(items, clause);
  if (independentGroups.length > 1) {
    return independentGroups.some((group) => hasUnresolvedCatalogVariant(items, group, true));
  }
  const exactIndexes = exactCatalogItemSpanIndexes(surfaceWords, exactItems);
  const modifierIndexes = catalogOperationalModifierIndexes(surfaceWords);
  const subjects = surfaceWords.map((word, index) => ({ word, index }))
    .filter(({ word, index }) => !CATALOG_DECISION_NOISE_RE.test(word)
      && !modifierIndexes.has(index) && !exactIndexes.has(index));
  const supportedIndexes = surfaceWords.map((word, index) => ({ word, index }))
    .filter(({ word }) => catalogWordSupported(items, word)).map(({ index }) => index);
  const firstSupportedIndex = Math.min(Number.POSITIVE_INFINITY, ...supportedIndexes);
  const leadingQuantityIndexes = new Set(surfaceWords.map((word, index) => ({ word, index }))
    .filter(({ word, index }) => /^\d+$/u.test(word)
      && (exactIndexes.has(index + 1) || catalogWordSupported(items, surfaceWords[index + 1] || "")))
    .map(({ index }) => index));
  const unresolvedWords = subjects.filter(({ word, index }) =>
    !(/^\d+$/u.test(word) && (index < firstSupportedIndex || leadingQuantityIndexes.has(index))));
  // Once a concrete SKU owns its span, leftover words may describe only an
  // independently known category or an operational modifier. A token borrowed
  // from another item's name/description cannot silently extend this SKU.
  if (exactItems.length) {
    if (unresolvedWords.some(({ word }) => /\d/u.test(word) || /^[a-z]{1,3}$/iu.test(word))) return true;
    return unresolvedWords.some(({ word }) => !catalogWordSupportedByCategory(items, word));
  }
  // Without an exact SKU, keep adjacent catalog words bound to one catalog
  // record. Conjunctions and commas form independent choices, so "doners and
  // drinks" remains valid while "Doner Comet" cannot borrow Comet from pie.
  const groups = clause.split(/,\s*|\s+(?:и|және|мен)\s+/iu);
  return groups.some((group) => {
    const groupWords = catalogDecisionSubjectWords(group);
    const firstCatalogIndex = groupWords.findIndex((word) => catalogWordSupported(items, word));
    const relevant = groupWords.filter((word, index) =>
      !(/^\d+$/u.test(word) && firstCatalogIndex >= 0 && index < firstCatalogIndex));
    if (relevant.some((word) => /\d/u.test(word) || /^[a-z]{1,3}$/iu.test(word))) return true;
    const supported = relevant.filter((word) => catalogWordSupported(items, word));
    if (!supported.length) return requireCatalogSubject && relevant.length > 0;
    if (supported.length < relevant.length) return true;
    return !items.some((item) => catalogItemSupportsWords(item, relevant));
  });
}

function looksLikePluralCatalogLabel(value: unknown): boolean {
  return catalogSurfaceWords(value).some((word) =>
    /(?:ы|и|ьи|ов|ев|ей|лар|лер|дар|дер|тар|тер|s|es)$/iu.test(word));
}

function exactCatalogItemSpanIndexes(surfaceWords: string[], exactItems: any[]): Set<number> {
  const indexes = new Set<number>();
  for (const item of exactItems) {
    const itemWords = catalogSurfaceWords(item?.name || item?.title || "");
    if (!itemWords.length) continue;
    const spans: Array<{ start: number; strict: boolean }> = [];
    for (let start = 0; start + itemWords.length <= surfaceWords.length; start += 1) {
      const candidate = surfaceWords.slice(start, start + itemWords.length);
      if (itemWords.every((word, offset) => menuLexemesSameIdentity(word, candidate[offset]))) {
        spans.push({ start, strict: itemWords.every((word, offset) => word === candidate[offset]) });
      }
    }
    const selected = spans.some((span) => span.strict)
      ? spans.filter((span) => span.strict)
      : spans;
    for (const span of selected) {
      for (let offset = 0; offset < itemWords.length; offset += 1) indexes.add(span.start + offset);
    }
  }
  return indexes;
}

function groundedClauseHasCatalogCoverage(items: any[], clause: string, grounding: any): boolean {
  if (catalogNamedItemsInText(items, clause).length) return true;
  if (hasUnresolvedCatalogVariant(items, clause)) return false;
  const subjectWords = catalogDecisionSubjectWords(clause).filter((word) => !/^\d+$/u.test(word));
  if (subjectWords.length && subjectWords.every((word) => catalogWordSupported(items, word))) return true;
  const groundedItems = Array.isArray(grounding?.items) ? grounding.items : [];
  if (!groundedItems.some((item: any) => item?.match_kind === "exact_name")) return false;
  const queryTokens = menuLexemes(grounding?.lookup_query || "");
  const clauseTokens = menuLexemes(clause);
  return queryTokens.length > 0 && queryTokens.every((queryToken) =>
    clauseTokens.some((clauseToken) => menuLexemesRelated(queryToken, clauseToken)));
}

function catalogChoiceSubjects(items: any[], clause: string): Set<string> {
  const words = menuLexemes(clause);
  const surfaceWords = catalogSurfaceWords(clause);
  const categoryKeys = new Set<string>();
  const categoryTokensByKey = new Map<string, string[]>();
  const pluralMentionedCategoryKeys = new Set<string>();
  for (const item of items) {
    const category = String(item?.category_name || item?.category || "").trim();
    const categoryTokens = menuLexemes(category);
    if (categoryTokens.length && categoryTokens.every((token) =>
      words.some((word) => menuLexemesRelated(token, word)))) {
      const categoryKey = "category:" + categoryTokens.join("|");
      categoryKeys.add(categoryKey);
      categoryTokensByKey.set(categoryKey, categoryTokens);
      if (surfaceWords.some((word) => looksLikePluralCatalogLabel(word)
        && menuLexemes(word).some((stem) =>
          categoryTokens.some((token) => menuLexemesRelated(stem, token))))) {
        pluralMentionedCategoryKeys.add(categoryKey);
      }
    }
  }

  // Use the same span-aware exact-name resolver as live search. A literal item
  // wins over its category; an inflected/plural category mention may otherwise
  // match a short same-root SKU and must keep the category refusal visible.
  const exactItems = catalogNamedItemsInText(items, clause);
  if (exactItems.length) {
    if (hasUnresolvedCatalogVariant(items, clause)) return new Set();
    const keys = new Set(exactItems.map((item) =>
      "item:" + String(item?.name || item?.title || "").trim().toLocaleLowerCase("ru-RU")));
    const exactItemSpanIndexes = exactCatalogItemSpanIndexes(surfaceWords, exactItems);
    const independentlyMentionedCategories = [...categoryKeys].filter((key) => {
      const tokens = categoryTokensByKey.get(key) || [];
      return surfaceWords.some((word, index) => !exactItemSpanIndexes.has(index)
        && menuLexemes(word).some((stem) =>
          tokens.some((token) => menuLexemesRelated(stem, token))));
    });
    // A category token inside a multiword SKU belongs to that SKU. Preserve
    // category meaning only when it appears outside the exact span, or when a
    // one-token item is itself indistinguishable from its plural category label.
    const ambiguousSingleTokenCategories = [...pluralMentionedCategoryKeys].filter((key) => {
      const categoryTokens = categoryTokensByKey.get(key) || [];
      return exactItems.some((item) => {
        const itemWords = catalogSurfaceWords(item?.name || item?.title || "");
        const itemCategoryTokens = menuLexemes(item?.category_name || item?.category || "");
        if (itemWords.length !== 1 || itemCategoryTokens.join("|") !== categoryTokens.join("|")) return false;
        const categoryWords = catalogSurfaceWords(item?.category_name || item?.category || "");
        return surfaceWords.some((word, index) => exactItemSpanIndexes.has(index)
          && looksLikePluralCatalogLabel(word)
          && menuLexemesSameIdentity(itemWords[0], word)
          && (word !== itemWords[0] || categoryWords.includes(word)));
      });
    });
    for (const key of ambiguousSingleTokenCategories) keys.add(key);
    for (const key of independentlyMentionedCategories) keys.add(key);
    return keys;
  }

  // A number or short Latin size/code makes the request SKU-specific. If that
  // SKU is absent, a shared category token cannot authorize a sibling product.
  if (hasUnresolvedCatalogVariant(items, clause)) return new Set();
  return categoryKeys;
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
  const clauses = splitCatalogTextOutsideExactSpans(catalog, visible,
    /(?<=[.!?;])|\n|(?<!\p{L})(?:потом|затем|но|бірақ)(?!\p{L})|,\s*(?=(?:нет|жоқ|жок|не\s+хочу|хочу))/giu);
  const refusalRe = /(?:не\s+(?:хочу|буду|нужно|надо)|передумал|отказываюсь|керек\s*емес|қажет\s*емес|қаламай|алмай|бас\s*тарт)/iu;
  const informationalRe = /[?]|состав|құрам|ингредиент|что\s+входит|ішінде|из\s+чего|қандай|кандай|сколько|қанша|канша|цен|бағ|баг|сто(?:ит|ят)|бар\s*ма|есть\s+ли/iu;
  const selectionRe = /(?:хочу(?:\s+(?:заказать|взять))?|закажу|возьму|беру|(?<!\p{L})дай(?:те)?(?!\p{L})|нуж(?:ен|на|но|ны)|мне|маған|тогда|онда|керек|алғым\s*кел|алайын|аламын|тапсырыс\s*(?:бер|жаса))/iu;
  const quantitySelectionRe = /(?:^|[^\p{L}\p{N}])(?:[1-9]\d?|один|одну|два|две|три|бір|екі|үш)\s+\p{L}/iu;
  for (const raw of clauses) {
    const clause = raw.trim();
    if (!clause || /(?<!\p{L})(?:если|бы|вчера|кеше|раньше|бұрын|цитир\p{L}*)(?!\p{L})/iu.test(clause)) continue;
    const generalRefusal = /(?:(?:передумал\p{L}*[, ]*)?(?:ничего|ештеңе|ештене)\s+(?:не\s+)?(?:хочу|буду|нужно|надо|керек|қажет|қаламай\p{L}*|алмай\p{L}*)|(?:не\s+(?:хочу|буду|нужно|надо)|қаламай\p{L}*|керек\s+емес)\s+(?:ничего|ештеңе|ештене)|(?:отмен(?:а|яю|ить)|болдырма)\s*(?:вс[её]|бәрін|барлығын)?|^(?:(?:я|мен)\s+)?(?:передумал\p{L}*|ойымнан\s+қайттым)[.!\s]*$)/iu.test(clause);
    if (generalRefusal) {
      decisions.clear();
      decisions.set("grounded:query", false);
      saw = true;
      continue;
    }
    const refused = refusalRe.test(clause);
    // A grounded item mention is still only a question when the customer asks
    // for price, composition or availability. In particular, Kazakh "қандай"
    // must not match the unbounded Russian imperative fragment "дай".
    const informational = informationalRe.test(clause);
    const selected = !refused && !informational
      && (selectionRe.test(clause) || quantitySelectionRe.test(clause));
    const subjects = catalogChoiceSubjects(catalog, clause);
    const clauseWords = menuLexemes(clause.replace(/-/gu, " "));
    const lookupOverlap = lookupTokens.length && lookupTokens.some((token) =>
      clauseWords.some((word) => menuLexemesRelated(token, word)));
    const unresolvedVariant = hasUnresolvedCatalogVariant(catalog, clause);
    // Colloquial aliases such as Кола -> Coca-Cola may use the grounded query
    // only for a single positive choice. Refusals can still cancel that exact
    // grounding; a later unknown choice cannot borrow whole-turn query tokens.
    const clauseCatalogCoverage = groundedClauseHasCatalogCoverage(catalog, clause, grounding);
    if (!subjects.size && !unresolvedVariant && clauseCatalogCoverage && (selected || refused)) {
      const decisionWords = catalogDecisionSubjectWords(clause).filter((word) => !/^\d+$/u.test(word));
      for (const item of allowed) {
        if (!decisionWords.length || !catalogItemSupportsWords(item, decisionWords)) continue;
        const name = String(item?.name || item?.title || "").trim();
        if (name) subjects.add("item:" + name.toLocaleLowerCase("ru-RU"));
      }
    }
    if (!subjects.size && lookupOverlap
      && (refused || selected && !unresolvedVariant && clauseCatalogCoverage)) {
      subjects.add("grounded:query");
    }
    if (!subjects.size) {
      if (selected) {
        decisions.clear();
        decisions.set("grounded:unresolved", false);
        saw = true;
      }
      continue;
    }
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

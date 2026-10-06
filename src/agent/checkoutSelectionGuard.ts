import type { FastFoodContext } from '../context/types.js';
import { isMenuBudgetInquiry } from '../utils/menuBudget.js';

const QUOTED_RE = /«[^»]*»|“[^”]*”|"[^"]*"|'[^'\n]*'/gu;
const LINK_RE = /ссылк|сілтеме|силтеме|(?:^|[^\p{L}])link(?=$|[^\p{L}])/iu;
const CHECKOUT_RE = /покуп|купить|купит|заказ|оформ|выбрать|выбер|выбор|сатып|алуға|алу\s+үшін|таңда|тапсырыс/iu;
const CHOICE_RE = /керек|қажет|кажет|алайын|аламын|аламыз|алғым|алгым|беріңіз|бериниз|берші|бершi|таңдадым|возьм|беру|хочу|нуж(?:на|ен|но|ны)|закаж/iu;
const ELLIPTIC_CHOICE_RE = /^(?:маған|маган|мне|онда|тогда|теперь)\s+/iu;
const QUANTIFIED_CHOICE_RE = /^(?:[1-9]\d{0,2}|один|одну|два|две|три|четыре|бір|екі|екi|үш)\s+/iu;
const INQUIRY_RE = /что\s+(?:есть|лучше|посовет)|посовет|порекоменду|сколько|бар\s+ма|не\s+бар|не\s+алайын|не\s+алуға|не\s+ұсын|қанша|канша|(?:^|[^\p{L}])(?:цена|цену|стоимость|бағасы|бағасын)(?=$|[^\p{L}])/iu;
const DENIAL_RE = /(?:^|[^\p{L}])(?:не|нет)(?=$|[^\p{L}])|қаламай|керек\s+емес|емес(?=$|[^\p{L}])|алмай|жоқ(?=$|[^\p{L}])|жок(?=$|[^\p{L}])|ұсынбай|усынбай/iu;
const REPORTED_CHOICE_RE = /раньше|прежде|он\s+(?:сказал|написал|хотел)|она\s+(?:сказала|написала|хотела)|бұрын|бурын|деп\s+(?:айт|жаз)/iu;
const DENIED_REPORT_RE = /(?:^|[^\p{L}])не\s+(?:говорил|говорила|сказал|сказала|писал|писала|утверждал|утверждала)(?=$|[^\p{L}])/iu;
const NOMINAL_PRODUCT_REFUSAL_RE = /(?:^|[^\p{L}])не\s+нуж\p{L}*(?=$|[^\p{L}])|(?:керек|қажет|кажет)\s+емес/iu;
const PURCHASE_ACTION_RE = /^(?:покупать|купить|брать|взять|заказывать|заказать|выбирать|выбрать|есть|пить|кушать)(?=$|[^\p{L}])/iu;
const CHECKOUT_DENIED_RE = /(?:^|[^\p{L}])не\s+(?:предлагаю|предлагаем|даю|даём|отправляю|выдаю)[^.!?;]{0,40}ссылк|ссылк\p{L}*[^.!?;]{0,40}\s+не\s+(?:для|предназнач\p{L}*)(?=$|[^\p{L}])|(?:сілтеме|силтеме)[^.!?;]{0,60}(?:сатып\s+алу|алуға|алу\s+үшін)[^.!?;]{0,20}емес/iu;
const ALTERNATIVE_RE = /альтернатив|как\s+вариант|вместо|можно\s+также|балама/iu;
const OPT_IN_PREFIX_RE = /^(?:қаласаңыз|каласаныз|если\s+хотите)[.!?;]?$/iu;
const ALTERNATIVE_PREFIX_RE = /^(?:как\s+вариант|как\s+альтернатив[ау]|в\s+качестве\s+альтернативы|балама\s+ретінде)[.!?;]?$/iu;
const PRODUCT_CONDITION_RE = /^(?:егер|если\s+(?:хотите|нужен|нужна)|қаласаңыз|каласаныз)(?=$|[^\p{L}])/iu;
const PRODUCT_DESIRE_RE = /керек|қажет|кажет|хотите|нужен|нужна|қаласаңыз|каласаныз/iu;

function unquoted(value: string) {
  return value.replace(QUOTED_RE, ' ');
}

function words(value: unknown): string[] {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е')
    .replace(/(?:coca[-\s]*cola|кока[-\s]*кол[ауые]|(?:^|[^\p{L}])cola(?=$|[^\p{L}]))/gu, ' кола ')
    .match(/[\p{L}\p{N}]+/gu) || [];
}

// Match bounded case endings against catalog words, rather than arbitrary
// substrings or a hardcoded dish. Only the product family is compared here;
// this helper does not establish a specific variant, price or availability.
function sameCatalogWord(title: string, token: string): boolean {
  if (title === token) return true;
  if (title.length < 3 || token.length > title.length + 12) return false;
  if (token.startsWith(title)) {
    const suffix = token.slice(title.length);
    if (/^(?:(?:лар|лер|дар|дер|тар|тер))?(?:ды|ді|ты|ті|ны|ні|ға|ге|қа|ке|дан|ден|тан|тен|нан|нен|ның|нің|дың|дің|тың|тің|мен|бен|пен)?$/u.test(suffix)) return true;
    if (/^(?:а|у|ы|и|е|ом|ам|ами|ах|ов|ей|s|es)$/u.test(suffix)) return true;
  }
  if (title.endsWith('а')) return token.slice(0, -1) === title.slice(0, -1) && /[ауые]$/u.test(token)
    || token.startsWith(title.slice(0, -1)) && /^(?:ой|ою|ам|ами|ах)$/u.test(token.slice(title.length - 1));
  if (title.endsWith('я')) return token.startsWith(title.slice(0, -1))
    && /^(?:ю|и|е|ей|ям|ями|ях)$/u.test(token.slice(title.length - 1));
  if (title.endsWith('ь')) return token.startsWith(title.slice(0, -1))
    && /^(?:я|ю|е|и|ей|ем)$/u.test(token.slice(title.length - 1));
  return false;
}

function catalogFamilies(ctx: FastFoodContext): string[] {
  const items = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
  const families = new Set<string>();
  for (const item of items.slice(0, 2000)) {
    const title = words(String(item?.name || item?.title || '').slice(0, 160));
    // A descriptive adjective at the start of a title is not the selected dish
    // (e.g. it may describe several different products in this same catalog).
    const head = title.find((token) => token.length >= 3 && !/\d/u.test(token)
      && !/^(?:без|для)$/u.test(token) && !/(?:ый|ий|ая|ое|ые)$/u.test(token));
    if (head) families.add(head);
  }
  return [...families];
}

function mentionedFamilies(value: string, families: string[]): string[] {
  const tokens = words(unquoted(value));
  return families.filter((family) => tokens.some((token) => sameCatalogWord(family, token)));
}

export function hasCatalogProductMention(value: string, ctx: FastFoodContext): boolean {
  return mentionedFamilies(value, catalogFamilies(ctx)).length > 0;
}

export function hasCatalogSafetyAssertion(value: string, ctx: FastFoodContext, directSubjectOnly = false): boolean {
  const plain = unquoted(value).trim();
  if (plain.includes('?')) return false;
  // A dependent or hypothetical clause does not independently assert safety.
  // The caller inspects each complete sentence and each independent clause.
  if (/^(?:что|если|егер)(?=$|[^\p{L}])|^(?:я\s+)?не\s+(?:могу|можем|утвержда|подтвержда|говор|сказ|гаранти)/iu.test(plain)) return false;
  const tokens = words(plain.slice(0, 2000));
  const families = catalogFamilies(ctx);
  const foodPositions = tokens.flatMap((token, index) => families.some(family => sameCatalogWord(family, token)) ? [index] : []);
  for (let index = 0; index < tokens.length; index++) {
    if (!/^(?:безопас(?:ен|н(?:а|о|ы|ый|ая|ое|ые|ую|ого|ой|ым|ыми|ому|ых))|қауіпсіз)$/u.test(tokens[index])) continue;
    if (tokens[index - 1] === 'не' || /^(?:емес|бе|ли)$/u.test(tokens[index + 1] || '')) continue;
    for (const food of foodPositions) {
      if (Math.abs(index - food) > 8) continue;
      const subject = tokens.slice(food < index ? 0 : index + 1, food < index ? index : food + 1);
      // Technical subjects can mention the dish without promising food safety.
      // Coordinated catalog foods, child qualifiers, copulas and adjectives are
      // still medical assertions under the caller's current allergy context.
      if (subject.some(token => /^(?:ссылк|оплат|доставк|сілтеме|силтеме|төлем|жеткізу)/u.test(token))) continue;
      if (subject.some(token => /^(?:если|егер)$/u.test(token))) continue;
      // A coordinated complement inherits a declared verification denial only
      // for an actual noun predicate, not a fresh speaker's asserting action.
      if (directSubjectOnly && !subject.every(token => families.some(family => sameCatalogWord(family, token))
        || /^(?:это|этот|эта|эти|бұл|осы|де|да|для|ребенка|ребенку|будет|будут|полностью|совершенно|точно|безусловно)$/u.test(token)
        || /(?:ый|ий|ая|ое|ые|ого|ую)$/u.test(token))) continue;
      return true;
    }
  }
  return false;
}

function refusedFamilies(value: string, families: string[]): string[] {
  if (NOMINAL_PRODUCT_REFUSAL_RE.test(value)) return mentionedFamilies(value, families);
  for (const match of value.matchAll(/(?:^|[^\p{L}])(\p{L}+)\s+(?:қаламай(?:мын|мыз)?|алмай(?:мын|мыз))(?=$|[^\p{L}])/giu)) {
    const direct = families.filter((family) => sameCatalogWord(family, words(match[1])[0] || ''));
    if (direct.length) return direct;
  }
  // A negated desire/future binds to a product noun or a real purchase/food
  // action. Refusing to read, compare or give up a product is not withdrawal.
  const predicate = /(?:^|[^\p{L}])не\s+(?:хочу|надо|буду|беру|возьму|закажу)(?=$|[^\p{L}])/giu;
  for (const match of value.matchAll(predicate)) {
    const before = value.slice(0, match.index);
    const after = value.slice((match.index || 0) + match[0].length).trim();
    const object = after.replace(PURCHASE_ACTION_RE, '').trim();
    const tokens = words(object);
    if (!tokens.length || tokens.every((token) => /^(?:больше|вообще|совсем|уже|теперь)$/u.test(token)))
      return mentionedFamilies(before, families);
    let index = 0;
    while (index < 2 && /^(?:\d{1,3}|один|одну|два|две|три|четыре|больше|вообще|совсем|уже|теперь)$/u.test(tokens[index] || '')) index++;
    if (families.some((family) => sameCatalogWord(family, tokens[index] || '')))
      return mentionedFamilies(object, families);
    if (/(?:ого|ую|ий|ый|ая|ое|ые|их|ому|ых)$/u.test(tokens[index] || '')
      && families.some((family) => sameCatalogWord(family, tokens[index + 1] || '')))
      return mentionedFamilies(object, families);
  }
  return [];
}

function currentSelection(ctx: FastFoodContext, families: string[]): Set<string> {
  const text = unquoted(String(ctx.text || '').slice(0, 4000));
  const selected = new Set<string>();
  const visit = (clause: string, maySplit: boolean) => {
    const clean = clause.trim();
    if (!clean) return;
    const inquiry = isMenuBudgetInquiry(clean) || INQUIRY_RE.test(clean);
    const denial = DENIAL_RE.test(clean);
    const reported = REPORTED_CHOICE_RE.test(clean) || DENIED_REPORT_RE.test(clean);
    // A simple affirmative coordinated selection shares its verb/quantity
    // (including «колу и донер хочу»). Mixed inquiry/refusal clauses instead
    // have separate intent and must be evaluated in their original order.
    if (maySplit && (inquiry || denial || reported)) {
      const parts = clean.split(/\s+(?:и|және|а)\s+/iu);
      if (parts.length > 1) {
        for (const part of parts) visit(part, false);
        return;
      }
    }
    if (inquiry || reported) return;
    const mentioned = mentionedFamilies(clean, families);
    const refused = refusedFamilies(clean, families);
    if (refused.length) {
      for (const family of refused) selected.delete(family);
      return;
    }
    if (denial) return;
    if (!CHOICE_RE.test(clean) && !ELLIPTIC_CHOICE_RE.test(clean) && !QUANTIFIED_CHOICE_RE.test(clean)) return;
    for (const family of mentioned) selected.add(family);
  };
  for (const clause of text.split(/[.!?;,\n]+|\s+(?:но|бірақ|однако)\s+/iu)) {
    visit(clause, true);
  }
  return selected;
}

export function guardCheckoutSelection(
  text: string,
  ctx: FastFoodContext,
  toolsCalled: readonly string[] = [],
): { text: string; changed: 'checkout_selection_mismatch_removed' | null } {
  const value = String(text || '');
  // The existing tool/link policy remains the authority. This guard cannot
  // grant or manufacture a URL and cannot imply that an order/cart was saved.
  if (ctx.magicLinkGranted !== true || !ctx.magicLink
    || !(ctx.menuGrounding?.menu_lookup === 'ok' || toolsCalled.includes('searchMenu')))
    return { text: value, changed: null };
  const families = catalogFamilies(ctx);
  const selected = currentSelection(ctx, families);
  if (!selected.size) return { text: value, changed: null };

  // Protect existing URLs from sentence/decimal separators. Their exact bytes
  // are retained; the validator already checked their authorization.
  const urls: string[] = [];
  const protectedText = value.replace(/https?:\/\/[^\s<>]+/giu, (url) => {
    urls.push(url);
    return `\u0000CHECKOUT_URL_${urls.length - 1}\u0000`;
  });
  let changed = false;
  const neutral = ctx.language === 'kk'
    ? 'Сілтеме арқылы таңдауыңызды жасай аласыз'
    : 'Выбрать нужное можно по ссылке';
  const corrected = protectedText.replace(/[^.!?;\n]+[.!?;]?/gu, (sentence) => {
    const parts = sentence.split(/(,|\s+[—–-]\s+|\s+(?=(?:но|однако|бірақ)\s)|\s+(?=(?:и|және)\s+(?:не\s+могу|не\s+подтверж|не\s+гарант|безопас|отсутств|состав|соответств|құрам|қауіп|диет|аллерг|жаңғақ))|\s+(?=без\s+гаранти|не\s+означа\p{L}*\s+гаранти))/iu);
    let conditionalFamilies: Set<string> | 'any' | null = null;
    let sentenceChanged = false;
    const result = parts.map((part) => {
      if (part === ',' || /^\s*$/u.test(part)) return part;
      const clean = unquoted(part);
      // An alternative applies only to this product clause or its immediately
      // preceding opt-in prefix. A later question/allergy condition cannot
      // excuse an unrelated wrong checkout object earlier in the sentence.
      const conditionalForPart = conditionalFamilies;
      conditionalFamilies = null;
      if (OPT_IN_PREFIX_RE.test(clean.trim()) || ALTERNATIVE_PREFIX_RE.test(clean.trim())) {
        conditionalFamilies = 'any';
        return part;
      }
      const condition = clean.split(LINK_RE)[0].split(CHECKOUT_RE)[0];
      const conditionProducts = PRODUCT_CONDITION_RE.test(condition.trim()) && PRODUCT_DESIRE_RE.test(condition)
        ? mentionedFamilies(condition, families) : [];
      if (conditionProducts.length) conditionalFamilies = new Set(conditionProducts);
      if ((!LINK_RE.test(clean) && !clean.includes('\u0000CHECKOUT_URL_'))
        || !CHECKOUT_RE.test(clean) || CHECKOUT_DENIED_RE.test(clean)) return part;
      const mentioned = mentionedFamilies(clean, families);
      if (!mentioned.length || mentioned.every((family) => selected.has(family))) return part;
      const alternativeIndex = clean.search(ALTERNATIVE_RE);
      if (alternativeIndex >= 0 && alternativeIndex < clean.search(CHECKOUT_RE)) return part;
      if (conditionalForPart === 'any' || conditionalForPart instanceof Set
        && mentioned.every((family) => conditionalForPart.has(family))) return part;
      if (conditionProducts.length && mentioned.every((family) => conditionProducts.includes(family))) return part;
      sentenceChanged = changed = true;
      const existingURLs = part.match(/\u0000CHECKOUT_URL_\d+\u0000/gu) || [];
      const prefix = part.match(/^\s*/u)?.[0] || '';
      const punctuation = part.match(/[.!?;]\s*$/u)?.[0] || '';
      return `${prefix}${neutral}${existingURLs.length ? `: ${existingURLs.join(' ')}` : ''}${punctuation}`;
    }).join('');
    return sentenceChanged ? result : sentence;
  });
  if (!changed) return { text: value, changed: null };
  return {
    text: corrected.replace(/\u0000CHECKOUT_URL_(\d+)\u0000/gu, (_, index: string) => urls[Number(index)]).trim(),
    changed: 'checkout_selection_mismatch_removed',
  };
}

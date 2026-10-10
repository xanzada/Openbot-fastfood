import type { FastFoodContext } from "../context/types.js";

// Only a composition follow-up carries a prior product identity into this turn.
// Previous replies never supply either the identity or the ingredient facts.
const COMPOSITION_FOLLOW_UP_RE = /^(?:(?:а|ал)\s+)?(?:ішінде\s+не\s+(?:бар|болады)|ишинде\s+не\s+бар|что\s+(?:у\s+него\s+)?внутри|из\s+чего(?:\s+(?:он|она|оно|это))?(?:\s+(?:состоит|сделан|сделана|сделано))?|(?:(?:его|её|ее|оның)\s+)?(?:состав|құрамы|курамы)(?:\s+(?:какой|қандай))?)[?.!]*$/iu;
const NEUTRAL_ACK_RE = /^(?:спасибо|рахмет|ок|ладно|жақсы|жарайды|понятно|түсінікті)[.!?\s]*$/iu;
const MAX_MENU_CONTEXT_TEXT = 4096;
const fold = (value: unknown) => String(value || "").toLowerCase().replace(/ё/g, "е").trim();
/** Keep topic scans linear and bounded even when an inbound message has unmatched quotes. */
export function stripMenuContextQuotes(value: unknown): string {
  return String(value || "").slice(0, MAX_MENU_CONTEXT_TEXT).replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");
}
const unquoted = stripMenuContextQuotes;

export function isContextualCompositionQuestion(text: unknown): boolean {
  return COMPOSITION_FOLLOW_UP_RE.test(fold(unquoted(text)));
}

export function customerCompositionSubject(ctx: FastFoodContext): string | null {
  if (!isContextualCompositionQuestion(ctx.text)) return null;
  const items = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
  const history = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [])
    .filter((entry: any) => entry.role === "user").slice(-6);
  for (const entry of history.reverse()) {
    const text = fold(unquoted(entry.text || entry.content));
    if (!text || text === fold(ctx.text)) continue;
    const words = text.match(/\p{L}{3,}/gu) || [];
    const names = [...new Set(items.filter((item: any) => {
      const nameWords = fold(item.name || item.title).match(/\p{L}{3,}/gu) || [];
      return nameWords.some((name) => words.some((word) => word === name || name.length >= 4 && word.startsWith(name)));
    }).map((item: any) => String(item.name || item.title).trim()).filter(Boolean))];
    if (names.length === 1) return names[0];
    if (names.length > 1 || !NEUTRAL_ACK_RE.test(text)) return null;
  }
  return null;
}

export function isMenuAttributeVerificationQuestion(value:unknown):boolean {
 const text=fold(unquoted(value));
 return /(?:об[ъь]ем|көлем|колем|размер)(?!\p{L})/iu.test(text)
  && /(?:подтверд|проверь|уточн|какой|сколько|нақты|тексер|қандай|не\s+придум|по\s+меню)/iu.test(text);
}
const MENU_RELATION_FOLLOW_UP_RE=/^(?:(?:а|и|ал)\s+)?(?:он|она|оно|это|ол)(?!\p{L})[^.!?]{0,140}(?:отдельно|в\s+(?:составе\s+)?комбо|бөлек|болек|комбода)[?.!]*$/iu;
/** A relation question can use only a fresh, scoped customer identity, never a previous reply. */
export function customerMenuRelationSubject(ctx:FastFoodContext):{subject:string|null;needsClarification:boolean}|null {
 const current=fold(unquoted(ctx.text));const attribute=isMenuAttributeVerificationQuestion(ctx.text);if(!attribute&&!MENU_RELATION_FOLLOW_UP_RE.test(current))return null;
 const items=Array.isArray(ctx.menuSnapshot?.items)?ctx.menuSnapshot.items:[];
 const exactNames=(text:string)=>{
  const names=[...new Set(items.map((item:any)=>String(item.name||item.title||"").trim()).filter(Boolean))].sort((a,b)=>b.length-a.length);
  const spans:{name:string;start:number;end:number}[]=[];
  for(const name of names){
   const target=fold(name);let from=0;let start:number;
   while((start=text.indexOf(target,from))!==-1){from=start+target.length;const end=from;
    if(/\p{L}|\p{N}/u.test(text[start-1]||"")||/\p{L}|\p{N}/u.test(text[end]||""))continue;
    if(!spans.some(span=>start<span.end&&end>span.start))spans.push({name,start,end});
   }
  }
  return [...new Set(spans.map(span=>span.name))];
 };
 // A newly stated product takes precedence over pronoun recovery.
 const currentNames=exactNames(current);if(currentNames.length)return attribute?{subject:currentNames.length===1?currentNames[0]:null,needsClarification:currentNames.length!==1}:null;
 const unknown={subject:null,needsClarification:true};const now=Date.now();
 for(const row of (Array.isArray(ctx.chatHistory)?ctx.chatHistory:[]).slice(-12).reverse()){
  if(!row||row.role!=="user")continue;
  const text=fold(unquoted(row.text??row.content??row.body??""));if(text===current)continue;
  if(row.instanceId&&row.instanceId!==ctx.instanceId||row.instance_id&&row.instance_id!==ctx.instanceId)return unknown;
  if(row.phone&&String(row.phone).replace(/\D/g,"")!==String(ctx.phone).replace(/\D/g,""))return unknown;
  const raw=row.createdAt??row.timestamp;const at=typeof raw==="number"?raw:Date.parse(String(raw||""));
  if(!Number.isFinite(at)||at>now||at<=now-30*60_000)return unknown;
  if(NEUTRAL_ACK_RE.test(text))continue;
  const names=exactNames(text);return names.length===1?{subject:names[0],needsClarification:false}:unknown;
 }
 return unknown;
}

const MENU_TOPIC_STOP_WORDS = new Set([
  "а", "ал", "и", "да", "тағы", "еще", "ещё", "басқа", "другие", "другой", "другое",
  "бар", "ма", "ме", "ба", "бе", "есть", "ли", "у", "вас", "сіздерде", "сыздерде",
  "какие", "какой", "қандай", "что", "хочу", "хотим", "посмотреть", "покажите", "көрсетіңіз",
  "меню", "мәзір", "мне", "маған", "нужен", "нужна", "нужно", "керек",
]);
const MENU_QUERY_NOISE = new Set([
  ...MENU_TOPIC_STOP_WORDS,
  "спасибо", "рахмет", "ок", "ладно", "жақсы", "жарайды", "понятно", "түсінікті",
]);
const MENU_FOLLOW_UP_NOISE = new Set([
  "а", "ал", "и", "да", "тағы", "еще", "ещё", "басқа", "другие", "другой", "другое",
]);
const ALTERNATIVE_FOLLOW_UP_RE = /^(?:(?:а|и|ал)\s+)?(?:(?:есть|бар)\s+)?(?:(?:другие|другой|другое)(?:\s+(?:варианты|варианттары))?|(?:еще|ещё)(?:\s+(?:что-нибудь|варианты?))?|тағы(?:\s+да|\s+бар\s*ма?)?|басқа(?:\s+(?:не|бірдеңе|нұсқалар))?)[?.!\s]*$/iu;
const INFLECTION_SUFFIXES = [
  "ларыңыз", "леріңіз", "дарыңыз", "деріңіз", "тарыңыз", "теріңіз",
  "лар", "лер", "дар", "дер", "тар", "тер",
  "иями", "ами", "ями", "ого", "ему", "ими", "ыми",
  "ая", "яя", "ое", "ее", "ые", "ие", "ой", "ей",
  "ов", "ев", "ом", "ем", "ам", "ям", "ах", "ях",
  "ның", "нің", "дың", "дің", "тың", "тің", "ны", "ні", "ға", "ге", "қа", "ке",
  "ды", "ді", "ты", "ті", "да", "де", "та", "те",
  "а", "я", "ы", "и", "е", "у", "ю",
].sort((left, right) => right.length - left.length);

export function menuLexemeStem(value: unknown): string {
  let word = fold(value).replace(/[^\p{L}\p{N}-]+/gu, "").replace(/^-+|-+$/g, "");
  let changed = true;
  while (changed && word.length >= 5) {
    changed = false;
    for (const suffix of INFLECTION_SUFFIXES) {
      // Russian plural -ы in words such as "салаты" must not be consumed as
      // the Kazakh accusative -ты; that produced the false stem "сала".
      if (/^(?:ты|ті|ды|ді)$/u.test(suffix) && /[аеёиоуыэюяәөұүі]$/u.test(word.slice(0, -suffix.length))) continue;
      if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
        word = word.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return word;
}

export function menuLexemes(value: unknown): string[] {
  return (fold(unquoted(value)).match(/[\p{L}\p{N}-]{3,}/gu) || []).map(menuLexemeStem).filter(Boolean);
}

// Shared RU/KK semantic stems for catalog categories and ingredients. Search,
// checkout decisions and refusal handling must use one equivalence source.
const MENU_SEMANTIC_STEM_GROUPS = [
  ["сусын", "ішетін", "ишетин", "напит"],
  ["тауық", "тауык", "кури"],
  ["сиыр", "говя"],
  ["картоп", "картоф"],
  ["тәтті", "сладост"],
  ["ірімшік", "сыр"],
  ["ащы", "остр"],
];
const inSemanticStemGroup = (token: string, group: string[]) => group.some((stem) =>
  token === stem || token.startsWith(stem));

export function menuLexemesSameIdentity(left: unknown, right: unknown): boolean {
  const a = menuLexemeStem(left);
  const b = menuLexemeStem(right);
  if (!a || !b) return false;
  if (a === b) return true;
  // Short Russian nouns can change only their final case vowel (кола/колу).
  // The main stemmer intentionally keeps at least four letters; compare this
  // narrow inflection shape without introducing semantic catalog aliases.
  return a.length === b.length && a.length >= 4
    && a.slice(0, -1) === b.slice(0, -1)
    && /[аеёиоуыэюя]/u.test(a.at(-1) || "")
    && /[аеёиоуыэюя]/u.test(b.at(-1) || "");
}

export function menuLexemesRelated(left: unknown, right: unknown): boolean {
  if (menuLexemesSameIdentity(left, right)) return true;
  const a = menuLexemeStem(left);
  const b = menuLexemeStem(right);
  return Boolean(a && b && MENU_SEMANTIC_STEM_GROUPS.some((group) =>
    inSemanticStemGroup(a, group) && inSemanticStemGroup(b, group)));
}

/** Exact catalog names stated in one customer phrase. A longer name suppresses
 * a shorter one only when their spans overlap; independent products survive.
 * Numeric tokens are kept here because `Пицца 30` and `Пицца 40` are different
 * SKUs even though ordinary semantic menu lexemes intentionally omit short ids. */
export function catalogNamedItemsInText<T extends Record<string, any>>(items: T[], value: unknown): T[] {
  // Catalog names may contain one-letter size codes, alphanumeric variants or
  // short numeric ids. Exact identity therefore retains every name token.
  const identityLexemes = (input: unknown) => (fold(input).slice(0, MAX_MENU_CONTEXT_TEXT).match(/[\p{L}\p{N}-]+/gu) || [])
    .map(menuLexemeStem).filter(Boolean);
  const words = identityLexemes(value);
  if (!words.length) return [];
  type CatalogSpan = { start: number; end: number; strict: boolean };
  const matches: Array<{ item: T; key: string; total: number; spans: CatalogSpan[] }> = [];
  const seen = new Set<string>();
  for (const item of items) {
    const name = String(item?.name || item?.title || "").trim();
    const key = fold(name);
    const tokens = identityLexemes(name);
    if (!name || !tokens.length || seen.has(key)) continue;
    const spans: CatalogSpan[] = [];
    for (let start = 0; start + tokens.length <= words.length; start += 1) {
      if (tokens.every((token, offset) => menuLexemesSameIdentity(token, words[start + offset]))) {
        spans.push({
          start,
          end: start + tokens.length - 1,
          strict: tokens.every((token, offset) => token === words[start + offset]),
        });
      }
    }
    if (spans.length) {
      seen.add(key);
      matches.push({ item, key, total: tokens.length, spans });
    }
  }
  // When one text span exactly identifies a catalog SKU, discard sibling
  // matches that exist only through the narrow case-vowel fallback. This keeps
  // inflections such as Кола/Колу while distinguishing real Моко/Мока SKUs.
  const preferred = matches.map((match) => ({
    ...match,
    spans: match.spans.filter((span) => span.strict || !matches.some((other) =>
      other !== match && other.spans.some((candidate) => candidate.strict
        && candidate.start === span.start && candidate.end === span.end))),
  })).filter((match) => match.spans.length);
  return preferred.filter((match) => match.spans.some(({ start, end }) =>
    !preferred.some((other) => other !== match && other.total > match.total
      && other.spans.some(({ start: outerStart, end: outerEnd }) => outerStart <= start && outerEnd >= end))))
    .map((match) => match.item);
}

function visibleWords(value: unknown): string[] {
  return fold(unquoted(value)).match(/[\p{L}\p{N}-]{2,}/gu) || [];
}

function catalogTopicInText(items: any[], value: unknown, allowItemName = false): string | null {
  const words = visibleWords(value).filter((word) => !MENU_TOPIC_STOP_WORDS.has(word));
  if (!words.length) return null;
  const categories = [...new Set(items.map((item) => String(item?.category_name || item?.category || "").trim()).filter(Boolean))];
  const categoryHits = words.filter((word) => categories.some((category) =>
    visibleWords(category).some((categoryWord) => menuLexemesRelated(word, categoryWord))));
  if (categoryHits.length) return [...new Set(categoryHits)].join(" ");

  if (!allowItemName) return null;
  const matchingCategories = [...new Set(items.filter((item) => {
    const nameWords = visibleWords(item?.name || item?.title);
    return words.some((word) => nameWords.some((nameWord) => menuLexemesRelated(word, nameWord)));
  }).map((item) => String(item?.category_name || item?.category || "").trim()).filter(Boolean))];
  return matchingCategories.length === 1 ? matchingCategories[0] : null;
}

export function isAlternativeMenuFollowUp(value: unknown): boolean {
  return ALTERNATIVE_FOLLOW_UP_RE.test(fold(unquoted(value)));
}

/**
 * Resolves only a catalog-derived topic. A current category always wins; bare
 * alternative follow-ups may look back through fresh, tenant-scoped customer
 * turns. Assistant prose is never evidence for the customer's topic.
 */
export function customerMenuTopic(ctx: FastFoodContext): string | null {
  const items = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
  const current = fold(unquoted(ctx.text));
  const currentTopic = catalogTopicInText(items, current);
  if (currentTopic) return currentTopic;
  if (!isAlternativeMenuFollowUp(current)) return null;

  const now = Date.now();
  for (const row of (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : []).slice(-12).reverse()) {
    if (!row || row.role !== "user") continue;
    const text = fold(unquoted(row.text ?? row.content ?? row.body ?? ""));
    if (!text || text === current) continue;
    if (row.instanceId && row.instanceId !== ctx.instanceId || row.instance_id && row.instance_id !== ctx.instanceId) return null;
    if (row.phone && String(row.phone).replace(/\D/g, "") !== String(ctx.phone).replace(/\D/g, "")) return null;
    const raw = row.createdAt ?? row.timestamp;
    const at = typeof raw === "number" ? raw : Date.parse(String(raw || ""));
    if (!Number.isFinite(at) || at > now || at <= now - 30 * 60_000) return null;
    if (NEUTRAL_ACK_RE.test(text)) continue;
    // Customer history can carry quoted/pasted instructions. It may recover only
    // a normal catalog subject, never a prompt-like instruction.
    if (/(?<!\p{L})(?:system|assistant|developer|ignore|prompt|инструкц\p{L}*|промпт\p{L}*|ассистент|жүйелік)(?!\p{L})/iu.test(text)) return null;
    return catalogTopicInText(items, text, true);
  }
  return null;
}

export function isMenuCategoryConsultation(ctx: FastFoodContext): boolean {
  return Boolean(customerMenuTopic(ctx));
}

/** Broad assortment enumeration is distinct from a one-to-three personalized recommendation. */
export function isBroadMenuCategoryBrowse(ctx: FastFoodContext): boolean {
  if (!isMenuCategoryConsultation(ctx)) return false;
  const text = fold(unquoted(ctx.text));
  if (/(?:состав|ингредиент\p{L}*|что\s+входит|из\s+чего|внутри|құрам|курам|ішін|ишин|цена|стоимост\p{L}*|сколько\s+стоит|баға|бағасы|қанша\s+тұрад|канша\s+тура)/iu.test(text)) return false;
  if (/(?:посовет\p{L}*|рекоменд\p{L}*|ұсын\p{L}*|кеңес\s*бер|подбери|таңдап\s*бер|на\s+(?:мой|наш)\s+вкус|маған\s+лайық|аллерг\p{L}*|без\s+\p{L}+|бюджет|вегетари|халал|остр\p{L}*|ащы|\d+\s*(?:тг|тенге|теңге))/iu.test(text)) return false;
  if (isAlternativeMenuFollowUp(text)
    || /(?:какие|какая|какой|какое|қандай|что\s+есть|не\s+бар|бар\s*ма|покаж\p{L}*|перечисл\p{L}*|ассортимент|вариант\p{L}*)/iu.test(text)) return true;

  // A short, bare category turn (for example, «А напитки?») is also a browse.
  // Named-item price/composition questions contain other subject words and stay
  // informational, so they do not inherit automatic link permission.
  const topicWords = visibleWords(customerMenuTopic(ctx));
  const subjectWords = visibleWords(text).filter((word) => !MENU_TOPIC_STOP_WORDS.has(word));
  return Boolean(subjectWords.length && topicWords.length
    && subjectWords.length <= topicWords.length
    && subjectWords.every((word) => topicWords.some((topicWord) => menuLexemesRelated(word, topicWord))));
}

export function filterMenuQueryNoise(words: string[]): string[] {
  if (words.length && words.every((word) => MENU_QUERY_NOISE.has(word))) return [];
  return words.filter((word) => !MENU_FOLLOW_UP_NOISE.has(word));
}

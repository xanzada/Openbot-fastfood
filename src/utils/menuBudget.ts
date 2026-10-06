import { foldIntentText } from "./intentText.js";

const AMOUNT_RE = /(?<![\p{L}\p{N}+\-.,])(\d{1,3}(?:[ \u00a0\u202f]\d{3}){1,2}|\d{1,7})\s*(?:тенге(?:ге|мен|лик)?|тг|kzt|₸)(?![\p{L}\p{N}])/giu;
const CURRENCY_RE = /(?<!\p{L})(?:тенге(?:ге|мен|лик)?|тг|kzt|₸)(?!\p{L})/iu;
const EXPLORATION_RE = /(?:не\s*(?:аламын|алсам|алуга|жеуге|усынасыз|бар)|кандай[^.!?]{0,30}(?:алсам|алуга|аламан)|что(?:\s+\p{L}+){0,3}\s*(?:взять|купить|выбрать|поесть|посоветуете)|на\s+что\s+хватит|что\s+посоветуете)/iu;
const HUNGER_RE = /(?:карным[^.!?]{0,30}аш|голод(?:ен|на|ный|ная)|студент)/iu;
const FOOD_RE = /(?:донер|пицц|бургер|шаурм|лаваш|фри|суши|ролл|наггетс|сэндвич|хот-?дог|кол[ау]|цезар|комбо)/iu;
const FOOD_CHOICE_RE = /(?:аламын|алайын|возьму|закажу|заказываю|хочу\s+(?:заказать|взять)|тапсырыс\s*(?:берей|берем|жаса))/iu;
const MONEY_LEG_RE = /(?:оплат|перевел|перевод|реквизит|кас[пб]и|чек|толед|толем|аудар|жеткиз|достав|курьер)/iu;
const DENIED_RE = /(?:керек\s*емес|кажет\s*емес|жок|(?<!\p{L})не\s+(?:хочу|нуж|надо|интерес|спрашива|буду)|нет\s+(?:денег|бюджет))/iu;

function currentBudgetClauses(text: string): string[] {
  const value = foldIntentText(String(text || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu, ""));
  // A refusal of an independent URL does not erase the food budget in that clause.
  const budgetText = value.replace(/(?:силтеме\p{L}*|ссылк\p{L}*|линк|link|url)[^\d.!?]{0,24}(?:(?:керек|кажет)\s*емес|кереги\s*жок|(?<!\p{L})не\s*(?:нуж\p{L}*|надо))|(?<!\p{L})не\s*(?:нуж\p{L}*|надо)[^\d.!?]{0,24}(?:силтеме\p{L}*|ссылк\p{L}*|линк|link|url)/giu, "");
  // Mask unsupported decimal amounts, preserving inquiry kind before punctuation splitting.
  const clauses = budgetText.replace(/\d+[.,]\d+(\s*(?:тенге(?:ге)?|тг|kzt|₸))(?!\p{L})/giu, (_match, currency) => "unsupported_amount " + currency)
    .split(/[.!?;,\n]+|(?<!\p{L})(?:но|бирак)(?!\p{L})/iu);
  // A real food choice remains a choice even if this turn previously considered a budget.
  if (clauses.some(clause => FOOD_RE.test(clause) && FOOD_CHOICE_RE.test(clause)
    && !/(?:не\s+(?:хочу|буду)|алмай|бар\s*ма|если|можно|могу)/iu.test(clause))) return [];
  const exploratory = EXPLORATION_RE.test(value);
  const hungry = HUNGER_RE.test(value);
  return clauses.filter(clause => CURRENCY_RE.test(clause) && !MONEY_LEG_RE.test(clause) && !DENIED_RE.test(clause)
    && (exploratory || hungry || /бюджет/iu.test(clause)));
}

/** Inquiry kind is independent of whether its stated amount supports deterministic advice. */
export function isMenuBudgetInquiry(text: string): boolean {
  return currentBudgetClauses(text).length > 0;
}

/** Current exploratory food budget only. Integer KZT (1..1,000,000), no quoted facts.
 * Decimals, ambiguous alternatives and non-KZT amounts are intentionally unsupported.
 * This amount grounds advice; unsupported amounts never grant checkout permission.
 */
export function getMenuBudgetInquiry(text: string): number | null {
  const amounts = new Set<number>();
  for (const clause of currentBudgetClauses(text)) {
    if (/\d\s*(?:или|немесе)\s*\d/iu.test(clause)) return null;
    for (const match of clause.matchAll(AMOUNT_RE)) {
      const amount = Number(match[1].replace(/\s/gu, ""));
      if (Number.isSafeInteger(amount) && amount > 0 && amount <= 1_000_000) amounts.add(amount);
    }
  }
  return amounts.size === 1 ? [...amounts][0] : null;
}

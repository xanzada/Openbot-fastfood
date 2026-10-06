import type { FastFoodContext } from "../context/types.js";

// Only a composition follow-up carries a prior product identity into this turn.
// Previous replies never supply either the identity or the ingredient facts.
const COMPOSITION_FOLLOW_UP_RE = /^(?:(?:а|ал)\s+)?(?:ішінде\s+не\s+(?:бар|болады)|ишинде\s+не\s+бар|что\s+(?:у\s+него\s+)?внутри|из\s+чего(?:\s+(?:он|она|оно|это))?(?:\s+(?:состоит|сделан|сделана|сделано))?|(?:(?:его|её|ее|оның)\s+)?(?:состав|құрамы|курамы)(?:\s+(?:какой|қандай))?)[?.!]*$/iu;
const NEUTRAL_ACK_RE = /^(?:спасибо|рахмет|ок|ладно|жақсы|жарайды|понятно|түсінікті)[.!?\s]*$/iu;
const fold = (value: unknown) => String(value || "").toLowerCase().replace(/ё/g, "е").trim();
const unquoted = (value: unknown) => String(value || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");

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

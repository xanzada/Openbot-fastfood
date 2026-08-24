import type { FastFoodContext } from "../context/types.js";

const STOP_WORDS = new Set([
  "уақытша","уакытша","временно","қазір","казир","сейчас","бүгін","бугин","сегодня","болмайды","жоқ","жок","нет","нету","мин","минут","сағат","сагат","час","дейін","дейин","до","қабылдамаймыз","кабылдамаймыз","сатылмайды","нельзя","недоступен","недоступна","недоступны","закончился","закончилась","закончились","отсутствует","отсутствуют","не","бар","есть","стоп","стоплист","лист",
]);

function normalize(value: unknown) {
  return String(value || "").toLowerCase().replace(/[ё]/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function noteId(note: any) {
  return String(note?.noteId || note?.id || "").trim();
}

const UNAVAILABLE_MARKER_RE = /(?:временно|уақытша|уакытша|нету?|жоқ|жок|болмайды|недоступ|законч|отсутств|сатылмайды|бітті|битти|таусыл|қалмады|калмады|стоп)/iu;

export function noteConstraintTerms(text: unknown): string[] {
  return normalize(text).split(" ")
    // A marker of unavailability is never part of what is unavailable. STOP_WORDS
    // covers the common spellings by hand, but an inflected one ("таусылды",
    // "бітті") slipped through and was then required to appear in the dish text,
    // so the note matched nothing at all.
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !UNAVAILABLE_MARKER_RE.test(token) && !/^\d+$/.test(token))
    .slice(0, 12);
}

// A shift note is not always an availability fact. Operators also leave purely
// informational ones ("Бүгін Цезарь салаты қосылды", "Жаңа промо: 2+1"), and
// there is no marker of unavailability in those at all. Falling back to the
// first clause turned such a note into a constraint, so publicNoteConstraints()
// published the newly ADDED dish as `unavailable_now` and the bot told guests it
// was out - the one failure mode that costs a sale outright. A note now
// constrains the menu only when it actually says something is unavailable;
// anything else contributes nothing, which is the safe direction because raw
// note text never reaches the model either way.
function availabilityConstraintTerms(text: unknown): string[] {
  const raw = String(text || "").trim();
  const clauses = raw.split(/[.!?;\r\n]+/u).map((part) => part.trim()).filter(Boolean);
  // Operators often append an instruction or audit marker after the actual
  // availability fact. Only the factual clause may define menu constraints.
  const factualClause = clauses.find((clause) => UNAVAILABLE_MARKER_RE.test(clause));
  if (!factualClause) return [];
  return noteConstraintTerms(factualClause);
}

export function matchingNoteIds(notes: any[] = [], value: unknown): string[] {
  const haystack = normalize(value);
  if (!haystack) return [];
  return notes.filter((note) => {
    // Only a note that actually says something is unavailable may be reported as
    // hit by the message: an informational note ("Бүгін Цезарь салаты қосылды")
    // counted as a hit made the model announce a newly added dish as out.
    const terms = availabilityConstraintTerms(note?.text);
    return terms.length > 0 && terms.some((term) => haystack.includes(term));
  }).map(noteId).filter(Boolean);
}

export function noteHistoryMeta(ctx: FastFoodContext, value: unknown) {
  const sourceNoteIds = matchingNoteIds(ctx.activeShiftNotes, `${ctx.text} ${String(value || "")}`);
  return sourceNoteIds.length ? { sourceNoteIds, noteDerived: true } : {};
}

// Kazakh and Russian inflect the same word differently in a note and on a menu
// ("пицца" in the note, "Пиццы" in the category), so terms are compared by stem
// against whole words. Whole-word comparison is what keeps a stem from matching
// an unrelated word that merely contains those letters.
function stemOf(term: string) {
  if (term.length >= 6) return term.slice(0, term.length - 2);
  if (term.length >= 5) return term.slice(0, term.length - 1);
  return term;
}

function textCarriesTerm(words: string[], term: string) {
  const stem = stemOf(term);
  return words.some((word) => word.startsWith(stem));
}

// "лаваш бітіп қалды, донер жоқ" blocked nothing at all: every content word of
// the note - including "бітіп" and "қалды", words no dish name contains - had to
// appear in the item, so the sold-out Донер stayed on sale and could even be
// recommended as a safe alternative (audit, 2026-08-12). Terms that name nothing
// in this catalog are therefore dropped before the all-terms rule is applied,
// which keeps the precision that rule exists for ("пицца пеперони жоқ" still
// hides only pepperoni) without letting narrative words disable the note.
export function menuVocabulary(items: any[] = []): string[] {
  const words = new Set<string>();
  for (const item of items || []) {
    const text = normalize([
      item?.name, item?.title, item?.category_name, item?.category, item?.composition, item?.description,
    ].filter(Boolean).join(" "));
    for (const word of text.split(" ")) if (word) words.add(word);
  }
  return Array.from(words);
}

function catalogTerms(terms: string[], vocabulary?: string[]): string[] {
  if (!vocabulary || !vocabulary.length) return terms;
  const named = terms.filter((term) => textCarriesTerm(vocabulary, term));
  return named.length ? named : terms;
}

export function menuItemBlockedByNotes(
  notes: any[] = [],
  item: Record<string, any> = {},
  vocabulary?: string[],
) {
  const itemText = normalize([item.name, item.title, item.category_name, item.category, item.composition, item.description].filter(Boolean).join(" "));
  // A note like "пицца пеперони жоқ" names one dish, not the whole category, so every
  // content word that names something in the catalog has to be present before an
  // item disappears. Single-word notes ("лаваш жоқ") still hide every dish that
  // lists the word anywhere, including inside their composition.
  const words = itemText.split(" ").filter(Boolean);
  const matched = notes.filter((note) => {
    const terms = catalogTerms(availabilityConstraintTerms(note?.text), vocabulary);
    return terms.length > 0 && terms.every((term) => textCarriesTerm(words, term));
  });
  return { blocked: matched.length > 0, noteIds: matched.map(noteId).filter(Boolean) };
}

export function publicNoteConstraints(notes: any[] = []) {
  return notes.map((note) => ({ note_id: noteId(note), blocked_terms: availabilityConstraintTerms(note?.text), expires_at: Number(note?.expiresAt || 0) || null }))
    .filter((entry) => entry.note_id && entry.blocked_terms.length);
}

// Notes reach the bot through two doors: the hub's runtime snapshot and the
// panel's shift_note_created webhooks into Redis. A hub that merely echoes
// shift_notes: [] - this one does, even right after its own webhook delivered a
// note - used to shadow the Redis list entirely, so the agent never saw what the
// operator had just written (live round, 2026-08-24). Merge instead: a hub entry
// wins on id collision, Redis-only notes survive.
export function mergeShiftNoteSources(runtimeNotes: unknown, cachedNotes: unknown) {
  const notesById = new Map<string, any>();
  for (const note of Array.isArray(runtimeNotes) ? runtimeNotes : []) {
    const id = String((note as any)?.noteId || (note as any)?.id || "").trim();
    if (id) notesById.set(id, note);
  }
  for (const note of Array.isArray(cachedNotes) ? cachedNotes : []) {
    const id = String((note as any)?.noteId || (note as any)?.id || "").trim();
    if (id && !notesById.has(id)) notesById.set(id, note);
  }
  return [...notesById.values()].filter((note: any) => String(note?.text || "").trim());
}

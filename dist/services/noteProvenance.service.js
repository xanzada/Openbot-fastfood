const STOP_WORDS = new Set([
    "уақытша", "уакытша", "қазір", "казир", "сейчас", "бүгін", "бугин", "сегодня", "болмайды", "жоқ", "жок", "нет", "мин", "минут", "сағат", "сагат", "час", "дейін", "дейин", "до", "қабылдамаймыз", "кабылдамаймыз", "сатылмайды", "нельзя", "недоступен", "недоступна", "не", "бар", "есть",
]);
function normalize(value) {
    return String(value || "").toLowerCase().replace(/[ё]/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
function noteId(note) {
    return String(note?.noteId || note?.id || "").trim();
}
export function noteConstraintTerms(text) {
    return normalize(text).split(" ")
        .filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token))
        .slice(0, 12);
}
export function matchingNoteIds(notes = [], value) {
    const haystack = normalize(value);
    if (!haystack)
        return [];
    return notes.filter((note) => {
        const terms = noteConstraintTerms(note?.text);
        return terms.length > 0 && terms.some((term) => haystack.includes(term));
    }).map(noteId).filter(Boolean);
}
export function noteHistoryMeta(ctx, value) {
    const sourceNoteIds = matchingNoteIds(ctx.activeShiftNotes, `${ctx.text} ${String(value || "")}`);
    return sourceNoteIds.length ? { sourceNoteIds, noteDerived: true } : {};
}
// Kazakh and Russian inflect the same word differently in a note and on a menu
// ("пицца" in the note, "Пиццы" in the category), so terms are compared by stem
// against whole words. Whole-word comparison is what keeps a stem from matching
// an unrelated word that merely contains those letters.
function stemOf(term) {
    if (term.length >= 6)
        return term.slice(0, term.length - 2);
    if (term.length >= 5)
        return term.slice(0, term.length - 1);
    return term;
}
function textCarriesTerm(words, term) {
    const stem = stemOf(term);
    return words.some((word) => word.startsWith(stem));
}
export function menuItemBlockedByNotes(notes = [], item = {}) {
    const itemText = normalize([item.name, item.title, item.category_name, item.category, item.composition, item.description].filter(Boolean).join(" "));
    // A note like "пицца пеперони жоқ" names one dish, not the whole category, so every
    // content word has to be present before an item disappears. Single-word notes
    // ("лаваш жоқ") still hide every dish that lists the word anywhere,
    // including dishes that only mention it inside their composition.
    const words = itemText.split(" ").filter(Boolean);
    const matched = notes.filter((note) => {
        const terms = noteConstraintTerms(note?.text);
        return terms.length > 0 && terms.every((term) => textCarriesTerm(words, term));
    });
    return { blocked: matched.length > 0, noteIds: matched.map(noteId).filter(Boolean) };
}
export function publicNoteConstraints(notes = []) {
    return notes.map((note) => ({ note_id: noteId(note), blocked_terms: noteConstraintTerms(note?.text), expires_at: Number(note?.expiresAt || 0) || null }))
        .filter((entry) => entry.note_id && entry.blocked_terms.length);
}

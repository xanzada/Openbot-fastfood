const STOP_WORDS = new Set([
    "уақытша", "уакытша", "временно", "қазір", "казир", "сейчас", "бүгін", "бугин", "сегодня", "болмайды", "жоқ", "жок", "нет", "нету", "мин", "минут", "сағат", "сагат", "час", "дейін", "дейин", "до", "қабылдамаймыз", "кабылдамаймыз", "сатылмайды", "нельзя", "недоступен", "недоступна", "недоступны", "закончился", "закончилась", "закончились", "отсутствует", "отсутствуют", "не", "бар", "есть", "стоп", "стоплист", "лист",
]);
function normalize(value) {
    return String(value || "").toLowerCase().replace(/[ё]/g, "е").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
function noteId(note) {
    return String(note?.noteId || note?.id || "").trim();
}
const UNAVAILABLE_MARKER_RE = /(?:временно|уақытша|уакытша|нету?|жоқ|жок|болмайды|недоступ|законч|отсутств|сатылмайды|бітті|битти|таусыл|қалмады|калмады|стоп)/iu;
export function noteConstraintTerms(text) {
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
function availabilityConstraintTerms(text) {
    const raw = String(text || "").trim();
    const clauses = raw.split(/[.!?;\r\n]+/u).map((part) => part.trim()).filter(Boolean);
    // Operators often append an instruction or audit marker after the actual
    // availability fact. Only the factual clause may define menu constraints.
    const factualClause = clauses.find((clause) => UNAVAILABLE_MARKER_RE.test(clause));
    if (!factualClause)
        return [];
    return noteConstraintTerms(factualClause);
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
        const terms = availabilityConstraintTerms(note?.text);
        return terms.length > 0 && terms.every((term) => textCarriesTerm(words, term));
    });
    return { blocked: matched.length > 0, noteIds: matched.map(noteId).filter(Boolean) };
}
export function publicNoteConstraints(notes = []) {
    return notes.map((note) => ({ note_id: noteId(note), blocked_terms: availabilityConstraintTerms(note?.text), expires_at: Number(note?.expiresAt || 0) || null }))
        .filter((entry) => entry.note_id && entry.blocked_terms.length);
}

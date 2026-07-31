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
export function menuItemBlockedByNotes(notes = [], item = {}) {
    const itemText = normalize([item.name, item.title, item.category_name, item.category, item.composition, item.description].filter(Boolean).join(" "));
    const matched = notes.filter((note) => noteConstraintTerms(note?.text).some((term) => itemText.includes(term)));
    return { blocked: matched.length > 0, noteIds: matched.map(noteId).filter(Boolean) };
}
export function publicNoteConstraints(notes = []) {
    return notes.map((note) => ({ note_id: noteId(note), blocked_terms: noteConstraintTerms(note?.text), expires_at: Number(note?.expiresAt || 0) || null }))
        .filter((entry) => entry.note_id && entry.blocked_terms.length);
}

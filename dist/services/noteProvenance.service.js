const STOP_WORDS = /* @__PURE__ */ new Set([
  "\u0443\u0430\u049B\u044B\u0442\u0448\u0430",
  "\u0443\u0430\u043A\u044B\u0442\u0448\u0430",
  "\u049B\u0430\u0437\u0456\u0440",
  "\u043A\u0430\u0437\u0438\u0440",
  "\u0441\u0435\u0439\u0447\u0430\u0441",
  "\u0431\u04AF\u0433\u0456\u043D",
  "\u0431\u0443\u0433\u0438\u043D",
  "\u0441\u0435\u0433\u043E\u0434\u043D\u044F",
  "\u0431\u043E\u043B\u043C\u0430\u0439\u0434\u044B",
  "\u0436\u043E\u049B",
  "\u0436\u043E\u043A",
  "\u043D\u0435\u0442",
  "\u043C\u0438\u043D",
  "\u043C\u0438\u043D\u0443\u0442",
  "\u0441\u0430\u0493\u0430\u0442",
  "\u0441\u0430\u0433\u0430\u0442",
  "\u0447\u0430\u0441",
  "\u0434\u0435\u0439\u0456\u043D",
  "\u0434\u0435\u0439\u0438\u043D",
  "\u0434\u043E",
  "\u049B\u0430\u0431\u044B\u043B\u0434\u0430\u043C\u0430\u0439\u043C\u044B\u0437",
  "\u043A\u0430\u0431\u044B\u043B\u0434\u0430\u043C\u0430\u0439\u043C\u044B\u0437",
  "\u0441\u0430\u0442\u044B\u043B\u043C\u0430\u0439\u0434\u044B",
  "\u043D\u0435\u043B\u044C\u0437\u044F",
  "\u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D",
  "\u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0430",
  "\u043D\u0435",
  "\u0431\u0430\u0440",
  "\u0435\u0441\u0442\u044C"
]);
function normalize(value) {
  return String(value || "").toLowerCase().replace(/[ё]/g, "\u0435").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}
function noteId(note) {
  return String(note?.noteId || note?.id || "").trim();
}
function noteConstraintTerms(text) {
  return normalize(text).split(" ").filter((token) => token.length >= 3 && !STOP_WORDS.has(token) && !/^\d+$/.test(token)).slice(0, 12);
}
function matchingNoteIds(notes = [], value) {
  const haystack = normalize(value);
  if (!haystack) return [];
  return notes.filter((note) => {
    const terms = noteConstraintTerms(note?.text);
    return terms.length > 0 && terms.some((term) => haystack.includes(term));
  }).map(noteId).filter(Boolean);
}
function noteHistoryMeta(ctx, value) {
  const sourceNoteIds = matchingNoteIds(ctx.activeShiftNotes, `${ctx.text} ${String(value || "")}`);
  return sourceNoteIds.length ? { sourceNoteIds, noteDerived: true } : {};
}
function menuItemBlockedByNotes(notes = [], item = {}) {
  const itemText = normalize([item.name, item.title, item.category_name, item.category, item.composition, item.description].filter(Boolean).join(" "));
  const matched = notes.filter((note) => noteConstraintTerms(note?.text).some((term) => itemText.includes(term)));
  return { blocked: matched.length > 0, noteIds: matched.map(noteId).filter(Boolean) };
}
function publicNoteConstraints(notes = []) {
  return notes.map((note) => ({ note_id: noteId(note), blocked_terms: noteConstraintTerms(note?.text), expires_at: Number(note?.expiresAt || 0) || null })).filter((entry) => entry.note_id && entry.blocked_terms.length);
}
export {
  matchingNoteIds,
  menuItemBlockedByNotes,
  noteConstraintTerms,
  noteHistoryMeta,
  publicNoteConstraints
};

import test from "node:test";
import assert from "node:assert/strict";
import { menuItemBlockedByNotes, menuVocabulary, publicNoteConstraints } from "../src/services/noteProvenance.service.js";

// Real rows from the live tenant menu: the doner never names "лаваш" in its
// title, only deep inside the description, which is exactly where an honest
// answer has to look before offering it as a replacement.
const DONER = {
  name: "Донер (немесе донер-кебаб)",
  category_name: "Донер",
  composition: "Дәстүрлі түрде тауық еті, сиыр еті немесе қой еті.",
  description: "Көкөніс пен соус қосылған шелпек, лаваш немесе питаға оралады.",
};
const PEPPERONI = { name: "Пицца пеперони", category_name: "Пиццы", composition: "Пеперони шұжығы, моцарелла." };
const FOUR_SEASONS = { name: "4 сезона", category_name: "Пиццы", composition: "Моцарелла, тағы басқа ірімшік түрлері." };

test("an ingredient that ran out hides every dish built on it, even when only the composition names it", () => {
  const notes = [{ id: "32", text: "лаваш жоқ" }];
  assert.equal(menuItemBlockedByNotes(notes, DONER).blocked, true);
  assert.deepEqual(menuItemBlockedByNotes(notes, DONER).noteIds, ["32"]);
  // Nothing else on the menu is wrapped in lavash, so the rest stays sellable.
  assert.equal(menuItemBlockedByNotes(notes, FOUR_SEASONS).blocked, false);
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI).blocked, false);
});

test("a note naming one dish does not take its whole category down", () => {
  const notes = [{ id: "30", text: "пицца пеперони жоқ" }];
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI).blocked, true);
  assert.equal(menuItemBlockedByNotes(notes, FOUR_SEASONS).blocked, false);
  assert.equal(menuItemBlockedByNotes(notes, DONER).blocked, false);
});

test("operator instructions after the unavailable fact do not become dish-name constraints", () => {
  const notes = [{
    id: "live-post-deploy",
    text: "Донер временно нет. Сообщить клиенту и предложить замену. CODEX POST-DEPLOY REGRESSION.",
  }];

  assert.equal(menuItemBlockedByNotes(notes, DONER).blocked, true);
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI).blocked, false);
});

test("a one-word category note still clears that category", () => {
  const notes = [{ id: "30", text: "пицца жоқ" }];
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI).blocked, true);
  assert.equal(menuItemBlockedByNotes(notes, FOUR_SEASONS).blocked, true);
  assert.equal(menuItemBlockedByNotes(notes, DONER).blocked, false);
});

test("an empty note list blocks nothing", () => {
  assert.equal(menuItemBlockedByNotes([], DONER).blocked, false);
  assert.equal(menuItemBlockedByNotes([{ id: "1", text: "жоқ" }], DONER).blocked, false);
});

// An operator note is not always an availability fact. This one announces an
// ADDITION, and treating its words as constraints published the new dish as
// unavailable_now - so the bot told guests the dish the note was advertising had
// run out.
test("an informational note constrains nothing at all", () => {
  const notes = [{ id: "77", text: "Бүгін Пицца пеперони акцияда, 2+1. Клиенттерге айт." }];
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI).blocked, false);
  assert.equal(menuItemBlockedByNotes(notes, DONER).blocked, false);
  assert.deepEqual(publicNoteConstraints(notes), []);
});

test("an unavailability fact still constrains, whichever word the operator used", () => {
  for (const text of ["Пицца пеперони бітті", "Пицца пеперони таусылды", "Пицца пеперони стоп-лист"]) {
    const notes = [{ id: "78", text }];
    assert.equal(menuItemBlockedByNotes(notes, PEPPERONI).blocked, true, text);
    assert.equal(menuItemBlockedByNotes(notes, FOUR_SEASONS).blocked, false, text);
  }
});

// Audit 2026-08-12: the sold-out Донер stayed on sale, because "бітіп" and
// "қалды" - words no dish contains - were required to appear in the item too.
test("a note written as a sentence still blocks the dish it names", () => {
  const catalog = [DONER, PEPPERONI, FOUR_SEASONS];
  const vocabulary = menuVocabulary(catalog);
  const notes = [{ id: "80", text: "лаваш бітіп қалды, донер жоқ" }];
  assert.equal(menuItemBlockedByNotes(notes, DONER, vocabulary).blocked, true);
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI, vocabulary).blocked, false);
  assert.equal(menuItemBlockedByNotes(notes, FOUR_SEASONS, vocabulary).blocked, false);
});

test("narrative words never widen a note beyond the dish it names", () => {
  const catalog = [DONER, PEPPERONI, FOUR_SEASONS];
  const vocabulary = menuVocabulary(catalog);
  const notes = [{ id: "81", text: "Свет өшіп кетті, пицца пеперони жоқ" }];
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI, vocabulary).blocked, true);
  // The category as a whole is still sellable: the note named one pizza.
  assert.equal(menuItemBlockedByNotes(notes, FOUR_SEASONS, vocabulary).blocked, false);
  assert.equal(menuItemBlockedByNotes(notes, DONER, vocabulary).blocked, false);
});

test("a note naming nothing in the catalog is left as written, not widened", () => {
  const vocabulary = menuVocabulary([DONER, PEPPERONI, FOUR_SEASONS]);
  // "напитки жоқ" names no item in this Kazakh catalog: it must not silently
  // block a dish just because none of its terms could be verified.
  const notes = [{ id: "82", text: "напитки жоқ" }];
  assert.equal(menuItemBlockedByNotes(notes, PEPPERONI, vocabulary).blocked, false);
  assert.equal(menuItemBlockedByNotes(notes, DONER, vocabulary).blocked, false);
  // But it is still published as a constraint, so the model can see it.
  assert.deepEqual(publicNoteConstraints(notes), [{ note_id: "82", blocked_terms: ["напитки"], expires_at: null }]);
});

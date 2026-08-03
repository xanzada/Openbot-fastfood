import test from "node:test";
import assert from "node:assert/strict";
import { menuItemBlockedByNotes } from "../src/services/noteProvenance.service.js";

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

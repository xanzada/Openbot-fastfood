import assert from "node:assert/strict";
import test from "node:test";
import { pageMenuMatches, selectPublicMenuItems, summarizePublicCategories } from "../src/skills/searchMenu.skill.js";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";

// The failure these tests defend against: searchMenu built its ranked list with
// the same cap it used as a page size, so a catalog with 120 pizzas reported
// `totalMatched: 50, nextOffset: null` - a partial list that looked complete.
// The model then answered "барлығы осы" / "это всё, что у нас есть" while two
// thirds of the menu had never been counted. The prompt snapshot lied the same
// way: it printed the length of its own 60-item slice as the menu's count, under
// a rule that says a dish absent from the list does not exist.
function catalog(count: number, category = "Пиццы") {
  return Array.from({ length: count }, (_, index) => ({
    name: `${category} ${index + 1}`,
    category_name: category,
    composition: "Моцарелла, тесто.",
    price: 1000 + index,
  }));
}

test("a guest asking for the whole menu is never handed a partial list that looks complete", () => {
  const matches = selectPublicMenuItems(catalog(120), "", "", 120);
  const page = pageMenuMatches(matches);

  assert.equal(page.returned, 50);
  assert.equal(page.totalMatched, 120);
  assert.equal(page.hasMore, true);
  assert.equal(page.truncated, true);
  assert.equal(page.nextOffset, 50);
  assert.match(String(page.more_hint), /INCOMPLETE/);
  assert.match(String(page.more_hint), /offset=50/);
});

test("the ranked list counts every match, not just the first page's worth", () => {
  // The old cap lived inside selectPublicMenuItems, so no caller could ever
  // learn that more than 50 dishes matched.
  assert.equal(selectPublicMenuItems(catalog(120), "", "", 120).length, 120);
  assert.equal(selectPublicMenuItems(catalog(120), "пиццы", "", 200).length, 120);
});

test("paging with the offset the tool handed back reaches the rest of the menu", () => {
  const matches = selectPublicMenuItems(catalog(120), "", "", 120);
  const first = pageMenuMatches(matches);
  const second = pageMenuMatches(matches, 50, first.nextOffset ?? 0);
  const third = pageMenuMatches(matches, 50, second.nextOffset ?? 0);

  assert.equal(second.offset, 50);
  assert.equal(third.offset, 100);
  assert.equal(third.returned, 20);
  // Only the final page may report that nothing is left, and only then.
  assert.equal(third.hasMore, false);
  assert.equal(third.nextOffset, null);
  assert.equal("more_hint" in third, false);
  const seen = new Set([...first.items, ...second.items, ...third.items].map((item: any) => item.name));
  assert.equal(seen.size, 120);
});

test("a menu that really does fit in one page carries no false 'there is more' hint", () => {
  const page = pageMenuMatches(selectPublicMenuItems(catalog(9), "", "", 9));

  assert.equal(page.returned, 9);
  assert.equal(page.totalMatched, 9);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, null);
  assert.equal("truncated" in page, false);
});

test("a smaller page the model asked for still reports the honest total", () => {
  const page = pageMenuMatches(selectPublicMenuItems(catalog(120), "", "", 120), 5);

  assert.equal(page.returned, 5);
  assert.equal(page.totalMatched, 120);
  assert.equal(page.nextOffset, 5);
});

test("a page size above the cap cannot be used to dump the catalog into one answer", () => {
  const page = pageMenuMatches(selectPublicMenuItems(catalog(120), "", "", 120), 500);

  assert.equal(page.returned, 50);
  assert.equal(page.hasMore, true);
});

test("an offset past the end returns nothing and claims no further pages", () => {
  const page = pageMenuMatches(selectPublicMenuItems(catalog(12), "", "", 12), 50, 400);

  assert.equal(page.returned, 0);
  assert.equal(page.totalMatched, 12);
  assert.equal(page.hasMore, false);
});

// "Қандай категориялар бар?" used to be answered from a page of items, and with
// an empty query the ranking falls back to price, so the guest heard only the
// sections holding the cheapest dishes.
test("every section of the menu is enumerable, including the one holding only expensive dishes", () => {
  const items = [
    ...catalog(60, "Пиццы"),
    ...catalog(30, "Суши"),
    { name: "Сет Премиум", category_name: "Сеты", price: 25000 },
  ];
  const categories = summarizePublicCategories(items);

  assert.deepEqual(categories.map((entry) => entry.name), ["Пиццы", "Суши", "Сеты"]);
  assert.deepEqual(categories.map((entry) => entry.items), [60, 30, 1]);
});

test("a category is counted once whatever spelling or casing the catalog used", () => {
  const categories = summarizePublicCategories([
    { name: "A", category_name: "Пиццы" },
    { name: "B", category_name: "пиццы" },
    { name: "C", category: "ПИЦЦЫ" },
    { name: "D", category_name: "" },
  ]);

  assert.equal(categories.length, 1);
  assert.equal(categories[0].items, 3);
});

function contextWithSnapshot(snapshot: any): any {
  return {
    instanceId: "prestige",
    phone: "77476884956",
    text: "что у вас есть",
    senderMeta: {},
    language: "ru",
    languagePolicy: {},
    config: { brand: "Crazy Sushi", domain: "https://prestige.alemi.kz" },
    runtimeStatus: null,
    fetchedSettings: {},
    hardRealtimeContext: {},
    activeOrder: null,
    chatHistory: [],
    menuSnapshot: snapshot,
    activeShiftNotes: [],
    activeShiftNotesFingerprint: "",
    mediaContext: null,
    shporContext: [],
    magicLinkAlreadySent: false,
    customerProfile: null,
    conversationSummary: null,
    lastTurnTrace: null,
    activeGoal: null,
    thinking: null,
    proactiveSignals: null,
    explicitMenuLinkIntent: false,
    magicLink: "",
  };
}

test("the preloaded snapshot admits it is a sample, so dish 61 is never declared non-existent", () => {
  const prompt = buildFactsPrompt(contextWithSnapshot({
    source: "dle_spa_items",
    count: 214,
    items: catalog(60).map((item) => ({ name: item.name, price: item.price, category: item.category_name })),
  }));

  assert.match(prompt, /"total_on_menu": 214/);
  assert.match(prompt, /"truncated": true/);
  assert.match(prompt, /shows 60 of 214 menu items/);
  assert.match(prompt, /absence from it proves nothing/);
});

test("a fully carried menu is presented as complete, with no needless doubt added", () => {
  const prompt = buildFactsPrompt(contextWithSnapshot({
    source: "dle_spa_items",
    count: 3,
    items: catalog(3).map((item) => ({ name: item.name, price: item.price, category: item.category_name })),
  }));

  assert.match(prompt, /"total_on_menu": 3/);
  assert.ok(!prompt.includes("truncation_rule"));
  assert.ok(!prompt.includes("proves nothing"));
});

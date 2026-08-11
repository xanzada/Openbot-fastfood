import assert from "node:assert/strict";
import test from "node:test";
import { normalizeMenuItem } from "../src/services/dle.service.js";

// Captured verbatim from hub.alemi.kz catalog.context.get for instance
// "prestige" on 2026-08-11. The live storefront renders this dish as "3 000 тг",
// which is what fixes the unit question: price_amount_minor holds whole tenge
// despite its name.
const HUB_ITEM = {
  available: true,
  bonus_earn_amount_minor: 0,
  category_id: "019fd154-761a-70d7-b13f-79d588fc800d",
  category_name: "Пиццы",
  composition: "Тонкий центр, высокие воздушные бортики.",
  description: "Высокие воздушные бортики, выпекается быстро (60-90 сек) в дровяной печи.",
  id: "019fd154-8402-76c8-970b-10ef7bea366e",
  name: "Неаполитанская",
  price_amount_minor: 3000,
  compare_at_price_amount_minor: null,
  tags: ["hit", "new"],
};

test("A hub catalog item keeps its real price and its UUID identity", () => {
  const item = normalizeMenuItem(HUB_ITEM);

  assert.equal(item.price, 3000, "price_amount_minor is whole tenge and must not be divided");
  assert.equal(item.id, "019fd154-8402-76c8-970b-10ef7bea366e");
  assert.equal(item.category_id, "019fd154-761a-70d7-b13f-79d588fc800d");
  assert.equal(item.name, "Неаполитанская");
  assert.equal(item.available, true);
  assert.deepEqual(item.tags, ["hit", "new"]);
  assert.equal(item.label, "hit");
  assert.equal(item.compare_at_price, 0);
  assert.equal(item.bonus, 0);
});

test("The legacy field names still win when a payload carries them", () => {
  const item = normalizeMenuItem({ id: 41, name: "Дönер", price: 1800, promo_price: 1500, label: "акция" });

  assert.equal(item.price, 1800);
  assert.equal(item.promo_price, 1500);
  assert.equal(item.id, "41");
  assert.equal(item.label, "акция");
});

test("A crossed-out compare-at price is never quoted as the offer", () => {
  const item = normalizeMenuItem({ name: "Ролл", price_amount_minor: 2200, compare_at_price_amount_minor: 2800 });

  assert.equal(item.price, 2200);
  assert.equal(item.compare_at_price, 2800);
  assert.equal(item.promo_price, 0);

  // A compare-at at or below the price is noise, not a discount.
  const flat = normalizeMenuItem({ name: "Ролл", price_amount_minor: 2200, compare_at_price_amount_minor: 2200 });
  assert.equal(flat.compare_at_price, 0);
});

test("A sold-out dish stays sold out, and a silent payload stays orderable", () => {
  assert.equal(normalizeMenuItem({ name: "Сет", available: false }).available, false);
  assert.equal(normalizeMenuItem({ name: "Сет" }).available, true);
});

test("A missing price is zero, not NaN", () => {
  const item = normalizeMenuItem({ name: "Сет", price_amount_minor: "не число" });

  assert.equal(item.price, 0);
  assert.equal(Number.isFinite(item.price), true);
});

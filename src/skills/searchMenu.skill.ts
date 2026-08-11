import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getMenuContext } from "../services/dle.service.js";
import type { FastFoodContext } from "../context/types.js";
import { publicNoteConstraints, menuItemBlockedByNotes } from "../services/noteProvenance.service.js";

function normalizeText(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreMenuItem(item: Record<string, any>, tokens: string[], query: string) {
  const name = normalizeText(item.name || item.title);
  const category = normalizeText(item.category_name || item.category);
  const label = normalizeText(item.label);
  const description = normalizeText(item.description);
  const composition = normalizeText(item.composition);
  const haystack = [name, category, label, description, composition].filter(Boolean).join(" ");

  let score = 0;
  if (name === query) score += 100;
  if (name.includes(query)) score += 50;
  if (category.includes(query)) score += 30;
  if (label.includes(query)) score += 20;
  for (const token of tokens) {
    if (!token) continue;
    if (name.includes(token)) score += 12;
    if (category.includes(token)) score += 8;
    if (description.includes(token)) score += 4;
    if (composition.includes(token)) score += 4;
    if (haystack.includes(token)) score += 2;
  }
  return score;
}

/**
 * Every distinct category the guest is allowed to see, with how many items sits
 * in each. "Қандай категориялар бар?" used to be answered from whatever page of
 * items the model happened to hold, and with an empty query the ranking sorts
 * by price, so the answer was the categories of the cheapest handful of dishes -
 * a real section of the menu simply did not exist as far as the guest was told.
 */
export function summarizePublicCategories(items: Record<string, any>[], limit = 40) {
  const counts = new Map<string, { name: string; items: number }>();
  for (const item of items) {
    const name = String(item?.category_name || item?.category || "").trim();
    if (!name) continue;
    const key = normalizeText(name);
    const entry = counts.get(key);
    if (entry) entry.items += 1;
    else counts.set(key, { name, items: 1 });
  }
  return Array.from(counts.values())
    .sort((left, right) => right.items - left.items || left.name.localeCompare(right.name))
    .slice(0, Math.max(1, Number(limit) || 40));
}

export function selectPublicMenuItems(items: Record<string, any>[], query = "", category = "", limit = 12) {
  const normalizedQuery = normalizeText(query);
  const normalizedCategory = normalizeText(category);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  // The 50 that used to be hard-wired here was not only a page size: the skill
  // asked for 50 to learn how many matches exist, so a category with 120 dishes
  // reported exactly 50 matches and no next page. The model then answered "that
  // is our whole menu" while two thirds of it were never counted. The ceiling is
  // now the caller's business - the tool pages the ranked list itself.
  const max = Math.max(1, Number(limit) || 12);
  return items
    .map((item) => ({ item, score: scoreMenuItem(item, tokens, normalizedQuery) }))
    .filter((entry) => {
      const itemCategory = normalizeText(entry.item.category_name || entry.item.category);
      return (!normalizedCategory || itemCategory.includes(normalizedCategory)) && (!normalizedQuery || entry.score > 0);
    })
    .sort((left, right) => right.score - left.score || Number(left.item.price || 0) - Number(right.item.price || 0))
    .slice(0, max)
    .map((entry) => {
      const name = normalizeText(entry.item.name || entry.item.title);
      const category = normalizeText(entry.item.category_name || entry.item.category);
      const body = normalizeText(`${entry.item.composition || ""} ${entry.item.description || ""}`);
      // "лаваш" is not a dish here, it is what the Донер is wrapped in. Without this
      // flag the model reads a hit it cannot explain and tells the guest we have
      // nothing, when the right answer is to offer the dish that contains it.
      const ingredientMatch = Boolean(
        normalizedQuery && !name.includes(normalizedQuery) && !category.includes(normalizedQuery) && body.includes(normalizedQuery)
      );
      return {
        name: entry.item.name,
        category: entry.item.category_name,
        ingredients: entry.item.composition || entry.item.description || "",
        price: entry.item.price,
        available: typeof entry.item.available === "boolean" ? entry.item.available : undefined,
        ...(ingredientMatch ? { matched_as_ingredient: true } : {}),
      };
    });
}

/**
 * One page of the ranked matches, plus the truth about what was left out. The
 * page and the total used to be the same number by construction, so a guest
 * asking "барлығын көрсетші" got 50 items and `nextOffset: null` and was told
 * that was the entire menu. Kept pure so the arithmetic can be tested without a
 * catalog, Redis or the agent.
 */
export function pageMenuMatches(allMatches: Record<string, any>[], limit?: number, offset?: number) {
  const requested = Math.min(50, Math.max(1, Number(limit || 50)));
  const start = Math.max(0, Number(offset || 0));
  const items = allMatches.slice(start, start + requested);
  const nextOffset = start + items.length < allMatches.length ? start + items.length : null;
  return {
    items,
    offset: start,
    nextOffset,
    totalMatched: allMatches.length,
    returned: items.length,
    hasMore: nextOffset !== null,
    ...(nextOffset !== null
      ? {
          truncated: true,
          more_hint: `Showing ${items.length} of ${allMatches.length} matching items. This list is INCOMPLETE - never say or imply it is everything we have. Call searchMenu again with offset=${nextOffset} for the next page, or with a category to narrow it down.`,
        }
      : {}),
  };
}

export function createSearchMenuSkill(ctx: FastFoodContext) {
  return createTool({
    name: "searchMenu",
    description: "Read customer-facing menu items, prices, ingredients, categories, and public availability from the live menu. Results are paged: at most 50 items per call. When the result says hasMore, the list is only part of the menu - page on with offset or narrow by category before answering, and never present a page as the full menu. The `categories` field lists every section of the catalog with its item count.",
    parameters: z.object({
      query: z.string().max(80).optional().describe("Food name or ingredient to search"),
      category: z.string().max(80).optional().describe("Customer-facing menu category to filter"),
      limit: z.number().int().min(1).max(50).optional().describe("Maximum number of menu items to return"),
      offset: z.number().int().min(0).max(5000).optional().describe("Pagination offset"),
    }),
    execute: async ({ query, category, limit, offset }) => {
      // Hub resolves the catalog by instance and ignores `domain`, so a tenant
      // without a storefront URL must still see its own menu.
      const domain = ctx.config?.domain || "";

      const menu = await getMenuContext(ctx.instanceId, domain, ctx.language);
      const items = Array.isArray(menu?.items) ? menu.items : [];
      const allowedItems = items.filter((item: any) => !menuItemBlockedByNotes(ctx.activeShiftNotes, item).blocked);
      // The ranked list behind the page is built in full: `totalMatched` has to be
      // the real number of matches, or the page and the total agree and nothing
      // tells the model that more of the menu exists.
      const allMatches = selectPublicMenuItems(allowedItems, query, category, allowedItems.length || 1);
      const page = pageMenuMatches(allMatches, limit, offset);
      const matches = page.items;
      const filteringApplied = items.length !== allowedItems.length;
      // Why an item vanished, without ever handing the model the operator's raw
      // wording: only the derived unavailable terms, which are safe to reason
      // about and useless to quote.
      const unavailableNow = filteringApplied
        ? Array.from(new Set(publicNoteConstraints(ctx.activeShiftNotes).flatMap((entry: any) => entry.blocked_terms || []))).slice(0, 12)
        : [];
      // A sales-minded agent never answers a plain "we don't have it". These are
      // drawn from allowedItems, which already dropped everything a note blocks,
      // so an alternative can never contain the missing ingredient itself.
      const safeAlternatives = matches.length === 0 && allowedItems.length
        ? selectPublicMenuItems(allowedItems, "", category, 3).map((item: any) => ({
            name: item?.name || item?.title || "",
            price: item?.price ?? null,
            category: item?.category || "",
          })).filter((item: any) => item.name)
        : [];
      return {
        // An unreachable catalog used to look exactly like an empty one, so the
        // bot confidently told guests a dish does not exist. The model needs to
        // see the difference to say "I cannot check right now" instead.
        ...(menu?.source === "menu_unavailable" ? { menu_lookup: "unavailable" } : {}),
        ...(safeAlternatives.length ? { safe_alternatives: safeAlternatives } : {}),
        // items / offset / nextOffset / totalMatched / returned / hasMore, and the
        // truncation hint whenever the page is shorter than the total.
        ...page,
        // The catalog's own section list, taken from every item the guest may be
        // shown - not from the page above. It is what makes "what categories do
        // you have?" answerable without paging the whole menu.
        categories: summarizePublicCategories(allowedItems),
        noteRestrictionsApplied: filteringApplied,
        ...(unavailableNow.length ? { unavailable_now: unavailableNow } : {}),
      };
    },
  });
}

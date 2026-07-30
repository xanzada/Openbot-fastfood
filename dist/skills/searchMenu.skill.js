import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getMenuContext } from "../services/dle.service.js";
import { publicNoteConstraints, menuItemBlockedByNotes } from "../services/noteProvenance.service.js";
function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[ё]/g, "е")
        .replace(/\s+/g, " ")
        .trim();
}
function scoreMenuItem(item, tokens, query) {
    const name = normalizeText(item.name || item.title);
    const category = normalizeText(item.category_name || item.category);
    const label = normalizeText(item.label);
    const description = normalizeText(item.description);
    const composition = normalizeText(item.composition);
    const haystack = [name, category, label, description, composition].filter(Boolean).join(" ");
    let score = 0;
    if (name === query)
        score += 100;
    if (name.includes(query))
        score += 50;
    if (category.includes(query))
        score += 30;
    if (label.includes(query))
        score += 20;
    for (const token of tokens) {
        if (!token)
            continue;
        if (name.includes(token))
            score += 12;
        if (category.includes(token))
            score += 8;
        if (description.includes(token))
            score += 4;
        if (composition.includes(token))
            score += 4;
        if (haystack.includes(token))
            score += 2;
    }
    return score;
}
export function selectPublicMenuItems(items, query = "", category = "", limit = 12) {
    const normalizedQuery = normalizeText(query);
    const normalizedCategory = normalizeText(category);
    const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
    const max = Math.min(50, Math.max(1, Number(limit) || 12));
    return items
        .map((item) => ({ item, score: scoreMenuItem(item, tokens, normalizedQuery) }))
        .filter((entry) => {
        const itemCategory = normalizeText(entry.item.category_name || entry.item.category);
        return (!normalizedCategory || itemCategory.includes(normalizedCategory)) && (!normalizedQuery || entry.score > 0);
    })
        .sort((left, right) => right.score - left.score || Number(left.item.price || 0) - Number(right.item.price || 0))
        .slice(0, max)
        .map((entry) => ({
        name: entry.item.name,
        category: entry.item.category_name,
        ingredients: entry.item.composition || entry.item.description || "",
        price: entry.item.price,
        available: typeof entry.item.available === "boolean" ? entry.item.available : undefined,
    }));
}
export function createSearchMenuSkill(ctx) {
    return createTool({
        name: "searchMenu",
        description: "Read customer-facing menu items, prices, ingredients, categories, and public availability from the live menu.",
        parameters: z.object({
            query: z.string().max(80).optional().describe("Food name or ingredient to search"),
            category: z.string().max(80).optional().describe("Customer-facing menu category to filter"),
            limit: z.number().int().min(1).max(50).optional().describe("Maximum number of menu items to return"),
            offset: z.number().int().min(0).max(5000).optional().describe("Pagination offset"),
        }),
        execute: async ({ query, category, limit, offset }) => {
            const domain = ctx.config?.domain || "";
            if (!domain) {
                return {
                    source: "domain_not_configured",
                    items: [],
                };
            }
            const menu = await getMenuContext(ctx.instanceId, domain, ctx.language);
            const items = Array.isArray(menu?.items) ? menu.items : [];
            const allowedItems = items.filter((item) => !menuItemBlockedByNotes(ctx.activeShiftNotes, item).blocked);
            const requested = limit || 50;
            const allMatches = selectPublicMenuItems(allowedItems, query, category, 50);
            const start = Math.max(0, Number(offset || 0));
            const matches = allMatches.slice(start, start + requested);
            const filteringApplied = items.length !== allowedItems.length;
            // Why an item vanished, without ever handing the model the operator's raw
            // wording: only the derived unavailable terms, which are safe to reason
            // about and useless to quote.
            const unavailableNow = filteringApplied
                ? Array.from(new Set(publicNoteConstraints(ctx.activeShiftNotes).flatMap((entry) => entry.blocked_terms || []))).slice(0, 12)
                : [];
            return {
                items: matches,
                offset: start,
                nextOffset: start + matches.length < allMatches.length ? start + matches.length : null,
                totalMatched: allMatches.length,
                noteRestrictionsApplied: filteringApplied,
                ...(unavailableNow.length ? { unavailable_now: unavailableNow } : {}),
            };
        },
    });
}

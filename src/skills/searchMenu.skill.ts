import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getMenuContext } from "../services/dle.service.js";
import type { FastFoodContext } from "../context/types.js";

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

export function createSearchMenuSkill(ctx: FastFoodContext) {
  return createTool({
    name: "searchMenu",
    description:
      "Search the live DLE menu for food names, categories, ingredients, availability, labels and prices. Always use this before answering about exact menu items or prices.",
    parameters: z.object({
      query: z.string().min(1).describe("Food, category, ingredient, or phrase to search, e.g. sushi, pizza, сет, ролл"),
      limit: z.number().int().min(1).max(15).optional().describe("Maximum number of menu items to return"),
    }),
    execute: async ({ query, limit }) => {
      const domain = ctx.config?.domain || "";
      if (!domain) {
        return {
          source: "domain_not_configured",
          query,
          count: 0,
          matches: [],
        };
      }

      const menu = await getMenuContext(ctx.instanceId, domain, ctx.language);
      const items = Array.isArray(menu?.items) ? menu.items : [];
      const normalizedQuery = normalizeText(query);
      const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
      const max = Math.min(15, Math.max(1, Number(limit || 8) || 8));

      const matches = items
        .map((item: any) => ({ item, score: scoreMenuItem(item, tokens, normalizedQuery) }))
        .filter((entry: any) => entry.score > 0)
        .sort((a: any, b: any) => b.score - a.score || Number(a.item.price || 0) - Number(b.item.price || 0))
        .slice(0, max)
        .map((entry: any) => ({
          id: entry.item.id,
          name: entry.item.name,
          category_id: entry.item.category_id,
          category_name: entry.item.category_name,
          description: entry.item.description,
          composition: entry.item.composition,
          price: entry.item.price,
          promo_price: entry.item.promo_price,
          label: entry.item.label,
          score: entry.score,
        }));

      return {
        source: menu?.source || "dle_spa_items",
        lang: menu?.lang,
        fetched_at: menu?.fetched_at,
        query,
        total_items: items.length,
        count: matches.length,
        matches,
      };
    },
  });
}

import { createTool } from "@voltagent/core";
import { z } from "zod";
import { getMenuContext } from "../services/dle.service.js";
import type { FastFoodContext } from "../context/types.js";

export function createSearchMenuSkill(ctx: FastFoodContext) {
  return createTool({
    name: "searchMenu",
    description: "Search the live DLE menu for food names, categories, availability and prices.",
    parameters: z.object({
      query: z.string().min(1),
    }),
    execute: async ({ query }) => {
      const menu = await getMenuContext(ctx.instanceId, ctx.config.domain || "", ctx.language);
      const items = Array.isArray(menu?.items) ? menu.items : [];
      const q = query.toLowerCase();
      const matches = items
        .filter((item: any) => {
          const hay = `${item.name || ""} ${item.title || ""} ${item.category || ""} ${
            item.description || ""
          }`.toLowerCase();
          return hay.includes(q) || q.split(/\s+/).some((part) => part && hay.includes(part));
        })
        .slice(0, 8);
      return {
        source: menu?.source,
        query,
        count: matches.length,
        matches,
      };
    },
  });
}

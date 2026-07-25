import { createTool } from "@voltagent/core";
import { z } from "zod";
const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
function isTavilyConfigured() {
  return Boolean(String(process.env.TAVILY_API_KEY || "").trim());
}
function normalizeSearchResult(item = {}) {
  return {
    title: String(item.title || "").trim().slice(0, 180),
    url: String(item.url || "").trim().slice(0, 500),
    content: String(item.content || item.snippet || "").trim().slice(0, 700)
  };
}
async function callTavily(payload, useBodyApiKey = false) {
  const apiKey = String(process.env.TAVILY_API_KEY || "").trim();
  const body = useBodyApiKey ? { ...payload, api_key: apiKey } : payload;
  const headers = { "Content-Type": "application/json" };
  if (!useBodyApiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(TAVILY_SEARCH_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error || data?.message || `Tavily HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}
async function searchWeb(query, options = {}) {
  const cleanQuery = String(query || "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!cleanQuery) return { ok: false, error: "EMPTY_QUERY", answer: "", results: [] };
  if (!isTavilyConfigured()) return { ok: false, error: "TAVILY_NOT_CONFIGURED", answer: "", results: [] };
  const payload = {
    query: cleanQuery,
    search_depth: options.searchDepth || "basic",
    include_answer: true,
    include_raw_content: false,
    max_results: Math.min(5, Math.max(1, Number(options.maxResults || 3)))
  };
  try {
    let data;
    try {
      data = await callTavily(payload, false);
    } catch (error) {
      if (error.status !== 401 && error.status !== 403) throw error;
      data = await callTavily(payload, true);
    }
    return {
      ok: true,
      answer: String(data.answer || "").trim().slice(0, 1e3),
      results: Array.isArray(data.results) ? data.results.map(normalizeSearchResult).filter((item) => item.title || item.content).slice(0, 5) : []
    };
  } catch (error) {
    return { ok: false, error: error.message || "TAVILY_SEARCH_FAILED", answer: "", results: [] };
  }
}
function createTavilySearchSkill(_ctx) {
  return createTool({
    name: "searchWeb",
    description: "Search the public web when local restaurant context is insufficient and current facts are needed.",
    parameters: z.object({
      query: z.string(),
      searchDepth: z.enum(["basic", "advanced"]).default("basic"),
      maxResults: z.number().int().min(1).max(5).default(3)
    }),
    execute: async ({ query, searchDepth, maxResults }) => searchWeb(query, { searchDepth, maxResults })
  });
}
export {
  createTavilySearchSkill,
  searchWeb
};

import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("internal text analysis never selects the media pool", async () => {
  const source = await readFile(new URL("../src/services/llm.service.ts", import.meta.url), "utf8");
  const start = source.indexOf("export function getAnalysisModel");
  const end = source.indexOf("function isTransientStatus", start);
  const body = source.slice(start, end);
  assert.match(body, /pools\?\.text/);
  assert.doesNotMatch(body, /pools\?\.media/);
});

test("magic links use the immediate transport lane", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const linkCalls = source.match(/requestScope: `\$\{messageId\}:magic-link`,\s+immediate: true/g) || [];
  assert.equal(linkCalls.length, 2);
});

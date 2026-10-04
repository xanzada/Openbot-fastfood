import test from "node:test";
import assert from "node:assert/strict";
import { compactConversationHistory } from "../src/context/buildFactsPrompt.js";

test("recent_dialog is bounded by a character budget on long chats", () => {
  const history = Array.from({ length: 72 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `m${i} ` + "х".repeat(480), createdAt: i + 1 }));
  const out = compactConversationHistory(history);
  const chars = out.reduce((n: number, e: any) => n + e.text.length, 0);
  assert.ok(out.length >= 4 && out.length < 16, `entries=${out.length}`);
  assert.ok(chars <= 4_000, `chars=${chars}`);
  assert.match(out[out.length - 1].text, /^m71 /);
});

test("short chats keep the full 8+8 window", () => {
  const history = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `короткое ${i}`, createdAt: i + 1 }));
  assert.equal(compactConversationHistory(history).length, 16);
});

test("the newest 4 entries survive even when the budget is tiny", () => {
  const previous = process.env.OPENBOT_DIALOG_CHAR_BUDGET;
  process.env.OPENBOT_DIALOG_CHAR_BUDGET = "1000";
  try {
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `b${i} ` + "я".repeat(2_000), createdAt: i + 1 }));
    const out = compactConversationHistory(history);
    assert.equal(out.length, 4);
    assert.match(out[3].text, /^b9 /);
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_DIALOG_CHAR_BUDGET; else process.env.OPENBOT_DIALOG_CHAR_BUDGET = previous;
  }
});

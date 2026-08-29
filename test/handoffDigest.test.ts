import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoffDigest } from "../src/skills/escalation.skill.js";

function ctx(overrides: Record<string, any> = {}) {
  return {
    instanceId: "tenant-a",
    phone: "77001234567",
    language: "ru",
    thinking: null,
    customerProfile: null,
    conversationSummary: null,
    activeOrder: null,
    ...overrides,
  } as any;
}

// The digest used to print "мақсат=info, көңіл-күй=neutral, шұғылдылық=normal" on
// every case, which told the operator nothing and pushed the real content down the
// screen (owner report, 2026-08-29). Only a state worth warning a human about
// survives, and the reason itself always leads.
test("the digest warns about a bad mood and stays quiet about an ordinary one", () => {
  const upset = buildHandoffDigest(ctx({ thinking: { goal: "complaint", mood: "upset", urgency: "high" } }), "заказ опоздал на час");
  assert.match(upset, /заказ опоздал на час/);
  assert.match(upset, /upset/);

  const ordinary = buildHandoffDigest(ctx({ thinking: { goal: "info", mood: "neutral", urgency: "normal" } }), "просит меню");
  assert.equal(ordinary, "просит меню", "a neutral turn adds nothing at all");
});

test("the digest tells the operator what we remember about this customer", () => {
  const digest = buildHandoffDigest(
    ctx({
      customerProfile: { self_introduced_name: "Aibek", complaint_count: 2, preferences: ["без лука"] },
    }),
    "повторная жалоба"
  );
  assert.match(digest, /Aibek/);
  assert.match(digest, /2/);
  assert.match(digest, /без лука/);
});

test("the digest includes the active order number and the earlier summary", () => {
  const digest = buildHandoffDigest(
    ctx({
      activeOrder: { number: "12345" },
      conversationSummary: { summary: "Вчера уже спрашивал про задержку доставки" },
    }),
    "снова опаздывает"
  );
  assert.match(digest, /12345/);
  assert.match(digest, /задержку доставки/);
});

test("a bare escalation still produces a usable digest", () => {
  const digest = buildHandoffDigest(ctx(), "просит человека");
  assert.match(digest, /просит человека/);
  assert.ok(digest.length < 900);
});

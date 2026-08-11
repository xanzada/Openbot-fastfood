import assert from "node:assert/strict";
import test from "node:test";
import { classifyMenuLinkRefusal } from "../src/skills/menuLink.skill.js";

const live = { hardRealtimeContext: { runtime_available: true } } as any;

test("A guest who asked and got a link is not refused", () => {
  assert.equal(classifyMenuLinkRefusal({ ...live, explicitMenuLinkIntent: true, magicLink: "https://x/auth/whatsapp/t" }), null);
});

test("A failed hub call is reported as a failure, not as a link already sent", () => {
  const reason = classifyMenuLinkRefusal({ ...live, explicitMenuLinkIntent: true, magicLink: null, magicLinkFailed: true });

  assert.equal(reason, "link_issue_failed");
});

test("A first-time guest with no link and no failure flag is still not told to use a previous link", () => {
  assert.equal(classifyMenuLinkRefusal({ ...live, explicitMenuLinkIntent: true, magicLink: null }), "link_issue_failed");
});

test("A resend after the link really was sent keeps the previous-link answer", () => {
  const reason = classifyMenuLinkRefusal({ ...live, explicitMenuLinkIntent: true, magicLink: null, magicLinkAlreadySent: true });

  assert.equal(reason, "link_already_sent");
});

test("An unreachable kitchen outranks every link question", () => {
  const reason = classifyMenuLinkRefusal({
    hardRealtimeContext: { runtime_available: false },
    explicitMenuLinkIntent: true,
    magicLink: null,
    magicLinkFailed: true,
  } as any);

  assert.equal(reason, "runtime_unavailable");
});

test("An active order lets the link through even when the kitchen status is unknown", () => {
  const reason = classifyMenuLinkRefusal({
    hardRealtimeContext: { runtime_available: false },
    activeOrder: { order: { id: 1 } },
    explicitMenuLinkIntent: true,
    magicLink: "https://x/auth/whatsapp/t",
  } as any);

  assert.equal(reason, null);
});

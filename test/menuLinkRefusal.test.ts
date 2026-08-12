import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { classifyMenuLinkRefusal } from "../src/skills/menuLink.skill.js";
import { classifyKitchenSalesPolicy } from "../src/services/kitchenPolicy.service.js";

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

const ready = { ...live, explicitMenuLinkIntent: true, magicLink: "https://x/auth/whatsapp/t" } as any;
const busy = classifyKitchenSalesPolicy({ wait_time: 65 });
const closed = classifyKitchenSalesPolicy({ is_accepting_orders: false });

// Asking for the link was a way around the wait question: the link went out and
// the checkout grace it wrote silenced the gate for good, so a guest facing a
// 65-minute queue was never told about it (audit, 2026-08-12).
test("The wait question is asked before the link, not after it", () => {
  assert.equal(classifyMenuLinkRefusal(ready, busy, false), "wait_consent_required");
});

test("Once the guest has accepted the wait, the same link request goes through", () => {
  assert.equal(classifyMenuLinkRefusal(ready, busy, true), null);
});

test("A closed kitchen hands out no checkout link at all", () => {
  assert.equal(classifyMenuLinkRefusal(ready, closed, true), "kitchen_closed");
});

test("A normal kitchen needs no consent to be remembered", () => {
  assert.equal(classifyMenuLinkRefusal(ready, classifyKitchenSalesPolicy({ wait_time: 20 }), false), null);
});

test("The consent check never turns a missing link into a sendable one", () => {
  assert.equal(
    classifyMenuLinkRefusal({ ...live, explicitMenuLinkIntent: true, magicLink: null, magicLinkFailed: true }, busy, true),
    "link_issue_failed",
  );
});

test("The gate stays armed while consent is owed - no checkout grace is written", async () => {
  const source = await readFile(new URL("../src/skills/menuLink.skill.ts", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("execute: async ()"));
  // The refusal must return before either mark* call, or the walkaround comes back.
  assert.ok(body.indexOf("if (refusal)") < body.indexOf("markMagicLinkSent"));
  assert.ok(body.indexOf("if (refusal)") < body.indexOf("markKitchenCheckoutStarted"));
  assert.match(body, /getKitchenCheckoutFingerprint\(ctx\.instanceId, ctx\.phone\)/);
  assert.match(body, /acceptedFingerprint === policy\.fingerprint/);
});

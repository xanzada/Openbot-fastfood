import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFactsPrompt } from "../src/context/buildFactsPrompt.js";
import { resumeDeferredKitchenConsent } from "../src/routes/whatsappWebhook.route.js";

function ctx(overrides: Record<string, any> = {}) {
  return {
    instanceId: "prestige",
    language: "kk",
    config: { brand: "Test" },
    chatHistory: [],
    shporContext: [],
    activeShiftNotes: [],
    customerProfile: null,
    thinking: null,
    activeGoal: null,
    proactiveSignals: null,
    hardRealtimeContext: {},
    runtimeStatus: null,
    ...overrides,
  } as any;
}

test("the note becomes a derived constraint, never raw operator text", () => {
  const out = buildFactsPrompt(ctx({
    activeShiftNotes: [{ noteId: "26", text: "свет өшіп сусындар жылып кеткен, напитки жоқ", expiresAt: Date.now() + 3600_000 }],
  }));
  // The operator writes shorthand for the kitchen, not a sentence for a guest.
  // Only the derived constraint may travel, so nothing quotable exists.
  assert.ok(!out.includes("свет өшіп"), "raw operator wording must not be present");
  assert.ok(out.includes("unavailable_now"), "derived constraint must reach the agent");
  assert.ok(out.includes("active_operator_notes_rule"));
  assert.ok(out.includes("кола belongs to сусындар"), "semantic hint must be present");
  assert.ok(out.includes("Warn the customer BEFORE they order"));
  assert.ok(out.includes("CONFIDENTIAL SOURCE"), "confidentiality must be stated");
});

test("without active notes neither notes nor the rule appear", () => {
  const out = buildFactsPrompt(ctx());
  assert.ok(!out.includes("active_operator_notes_rule"));
});

test("a 60-minute busy kitchen exposes wait_label and requires consent (kk)", () => {
  const out = buildFactsPrompt(ctx({
    hardRealtimeContext: { wait_time: 60, delivery: true, pickup: true },
    runtimeStatus: { wait_time: 60, delivery: true, pickup: true },
  }));
  assert.ok(out.includes('"wait_consent_required": true'));
  assert.ok(out.includes('"wait_label": "1 сағат"'));
});

test("a calm kitchen hides the wait entirely", () => {
  const out = buildFactsPrompt(ctx({
    hardRealtimeContext: { wait_time: 0, delivery: true, pickup: true },
    runtimeStatus: { wait_time: 0, delivery: true, pickup: true },
  }));
  assert.ok(out.includes('"wait_label": ""'));
  assert.ok(out.includes('"wait_consent_required": false'));
});

test("wait label is spoken form, not raw minutes", () => {
  const out = buildFactsPrompt(ctx({
    hardRealtimeContext: { wait_time: 120 },
    runtimeStatus: { wait_time: 120 },
  }));
  assert.ok(out.includes('"wait_label": "2 сағат"'));
  assert.ok(!out.includes('"wait_label": "120'));
});

test("an existing order never mutes the kitchen gate", () => {
  // Regression: a guest with an open order asked to order again and the bot
  // answered with a bare link, never mentioning the 60-minute wait, because
  // the gate returned early on activeOrder. Questions about an existing order
  // are answered before the gate, so anything reaching it is new intent.
  const src = readFileSync(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const gate = src.slice(src.indexOf("async function kitchenGateReply"));
  const body = gate.slice(0, gate.indexOf("\nasync function ", 10) + 1 || undefined);
  assert.ok(!/if \(ctx\.activeOrder\) return null;/.test(body), "the gate must not mute itself on an active order");
  // Consent branch markers: the deterministic ask/accept/decline machine must stay.
  assert.ok(body.includes("consentRequirement(policy"), "consent branch must remain");
  assert.ok(body.includes("savePendingKitchenConsent"), "the wait question must be remembered");
  assert.ok(body.includes('action: "accept"') || body.includes('"yes"'), "a clear yes must resume the order");
  assert.ok(body.includes("ambiguousConsentReply"), "an unclear answer must never fall through as consent");
});

test("accepting even a legacy wait consent resumes the personal order link", async () => {
  const issued: string[] = [];
  const marked: string[] = [];
  const continuationCtx = ctx({
    phone: "77476884956",
    language: "kk",
    config: { name: "Crazy Sushi" },
    magicLink: null,
    magicLinkGranted: false,
  });

  const reply = await resumeDeferredKitchenConsent(
    continuationCtx,
    {},
    {
      issueAccessLink: async (input: any) => {
        issued.push(`${input.instanceId}:${input.phone}:${input.locale}`);
        return "https://storefront.alemi.kz/auth/whatsapp#token=test";
      },
      markLinkSent: async (instanceId: string, phone: string) => {
        marked.push(`${instanceId}:${phone}`);
        return true;
      },
      upsertLead: async () => true,
    },
  );

  assert.equal(reply, "Жақсы, рақмет! Мәзірді жіберіп отырмын — осы арқылы кіріп, тапсырысыңызды бересіз.");
  assert.equal(continuationCtx.magicLinkGranted, true);
  assert.equal(continuationCtx.magicLink, "https://storefront.alemi.kz/auth/whatsapp#token=test");
  assert.deepEqual(issued, ["prestige:77476884956:kk"]);
  assert.deepEqual(marked, ["prestige:77476884956"]);
});

test("a deferred link failure stays honest and in the guest language", async () => {
  const continuationCtx = ctx({ phone: "77476884956", language: "ru", config: {}, magicLinkGranted: false });
  const reply = await resumeDeferredKitchenConsent(
    continuationCtx,
    { deferredMenuLinkIntent: true },
    {
      issueAccessLink: async () => null,
      markLinkSent: async () => true,
      upsertLead: async () => true,
    },
  );

  assert.equal(reply, "Спасибо, что подтвердили ожидание. Меню сейчас подготовить не получилось из-за технической ошибки — попросите ещё раз через пару минут.");
  assert.equal(continuationCtx.magicLinkGranted, false);
  assert.equal(continuationCtx.magicLinkFailed, true);
});

// The panel's "60 мин"/"120 мин" presets are informational notes: no
// unavailability marker, so the constraint path drops them entirely. The wait
// must still reach the agent as a fact, and the kitchen rule must not answer
// "no delays" over it (live round, 2026-08-24).
test("a 120-minute operator delay preset reaches FACTS and overrides normal-pace wording", () => {
  const out = buildFactsPrompt(ctx({
    activeShiftNotes: [{ noteId: "w1", text: "Ожидание увеличено примерно на 120 минут.", expiresAt: Date.now() + 3600_000 }],
  }));
  assert.ok(out.includes("operator_wait_notice_minutes"), "the announced minutes must reach the agent");
  assert.ok(out.includes("temporary delay"), "the timing rule must name the announced delay");
  assert.ok(!out.includes("kitchen is working at its normal pace"), "normal-pace wording must yield to an active notice");
});

test("an informational note with minutes does not create menu constraints", () => {
  const out = buildFactsPrompt(ctx({
    activeShiftNotes: [{ noteId: "w2", text: "Ожидание увеличено примерно на 120 минут." }],
  }));
  assert.ok(out.includes("operator_wait_notice_minutes"));
  assert.ok(!out.includes('"unavailable_now"'), "a pure delay note must not block any dish");
});

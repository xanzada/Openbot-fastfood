import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildHandoffDigest } from "../src/skills/escalation.skill.js";
import { buildEvidenceSeenReply } from "../src/services/complaintRouting.service.js";
import { normalizeMediaAnalysisResponse } from "../src/services/mediaAnalysis.service.js";

/**
 * The live nail complaint, 2026-08-29 (prestige, case oc_1788009815984_13b1ad30).
 *
 * A guest photographed a nail in their food. The bot answered "please describe the
 * problem in text" - TWICE, once per photo - even though the reader had already seen
 * the defect and written a summary. The operator then received that summary buried
 * under three of the guest's own past questions labelled "preferences" and an English
 * paragraph about pizzas from days earlier, with order_number "not_found" while order
 * #61 sat in the same conversation.
 */

test("visible evidence is reported by the reader instead of being asked about", () => {
  const seen = normalizeMediaAnalysisResponse(JSON.stringify({
    type: "complaint",
    admin_summary: "Тағамның үстінде тырнақ көрініп тұр",
    evidence_visible: true,
    evidence_detail: "Қай тағамнан шықты?",
  }));

  assert.equal(seen.type, "complaint");
  assert.equal(seen.evidence_visible, true);
  assert.equal(seen.evidence_detail, "Қай тағамнан шықты?");
  assert.match(seen.admin_summary, /тырнақ/);
});

// Strictly opt-in: an older model answer with no such field must behave exactly as
// before, or a deploy would start escalating blurry food photos.
test("a reader that says nothing about evidence still earns the clarifying question", () => {
  const quiet = normalizeMediaAnalysisResponse(JSON.stringify({ type: "complaint", admin_summary: "Шағым" }));
  assert.equal(quiet.evidence_visible, false);
  assert.equal(quiet.evidence_detail, "");

  const explicitFalse = normalizeMediaAnalysisResponse(JSON.stringify({ type: "complaint", evidence_visible: false }));
  assert.equal(explicitFalse.evidence_visible, false);

  // A non-boolean must never be read as permission.
  const junk = normalizeMediaAnalysisResponse(JSON.stringify({ type: "complaint", evidence_visible: "yes" }));
  assert.equal(junk.evidence_visible, false);
});

test("the guest is never asked to describe what the photo already showed", () => {
  const withDetail = buildEvidenceSeenReply("kk", "Қай тағамнан шықты?");
  assert.match(withDetail, /Кешіріңіз/);
  assert.match(withDetail, /Қай тағамнан шықты\?/);
  // The wording that caused the complaint must not appear.
  assert.doesNotMatch(withDetail, /сипаттап/);

  const bare = buildEvidenceSeenReply("kk");
  assert.match(bare, /админге жібердім/);
  assert.doesNotMatch(bare, /сипаттап/);

  const ru = buildEvidenceSeenReply("ru", "Из какого блюда?");
  assert.match(ru, /администратору/);
  assert.match(ru, /Из какого блюда\?/);
  assert.doesNotMatch(ru, /опишите/);
});

test("the same question is not asked twice for a second photo of the same problem", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const lane = source.slice(
    source.indexOf('if (mediaAnalysis.type === "complaint"'),
    source.indexOf('mediaPreemptiveSource = evidenceVisible')
  );

  assert.match(lane, /hasComplaintClarificationPending/);
  assert.match(lane, /complaint_media_awaiting_text/);
  // The pending flag has to be WRITTEN when the question goes out, or nothing
  // remembers it next time.
  assert.match(lane, /markComplaintClarificationPending\(ctx\.instanceId, ctx\.phone/);
  // Visible evidence skips the question entirely.
  assert.match(lane, /!evidenceVisible && !hasMeaningfulMediaDescription/);
});

// The operator's screen. "Which order?" is always their first question.
test("the handoff digest leads with the reason and the order number", () => {
  const digest = buildHandoffDigest({
    activeOrder: { display_number: 61, id: "01a04a09-df46-7b24-9d91-8720aae2500f" },
    thinking: { mood: "upset", urgency: "high" },
    customerProfile: { complaint_count: 2, preferences: ["самовывоз"] },
    conversationSummary: { summary: "Клиент пиццаға тапсырыс берді." },
  } as any, "Тамақтан тырнақ шықты");

  const lines = digest.split("\n");
  assert.equal(lines[0], "Тамақтан тырнақ шықты");
  assert.equal(lines[1], "Тапсырыс: №61", "the readable order number, not the uuid");
  assert.match(digest, /бұрынғы шағымдар: 2/);
});

test("the guest's own questions are never presented to the operator as preferences", () => {
  const digest = buildHandoffDigest({
    customerProfile: {
      preferences: [
        "Курьеру наличкой можно?",
        "Сілтемеге кіргім келмейді, осы жерде айтшы",
        "получать меню в текстовом виде",
        "меню жіберші",
      ],
    },
  } as any, "Шағым");

  // Every one of these was on the live operator screen. None is a preference.
  assert.doesNotMatch(digest, /можно\?/);
  assert.doesNotMatch(digest, /айтшы/);
  assert.doesNotMatch(digest, /жіберші/);
  // The old misleading label is gone too.
  assert.doesNotMatch(digest, /тілейіндері/);
});

test("an English summary is dropped rather than shown to a Kazakh-speaking operator", () => {
  const english = buildHandoffDigest({
    conversationSummary: { summary: "The customer ordered pizza in slices and asked about doner availability." },
  } as any, "Шағым");
  assert.doesNotMatch(english, /The customer ordered/);

  const kazakh = buildHandoffDigest({
    conversationSummary: { summary: "Клиент пиццаға тапсырыс берді, донер туралы сұрады." },
  } as any, "Шағым");
  assert.match(kazakh, /Бұған дейін: Клиент пиццаға/);
});

test("a neutral turn adds no noise at all", () => {
  const digest = buildHandoffDigest({
    thinking: { goal: "info", mood: "neutral", urgency: "normal" },
  } as any, "Клиент операторды сұрады");

  // "мақсат=info, көңіл-күй=neutral" told the operator nothing and pushed the real
  // content down the screen.
  assert.equal(digest, "Клиент операторды сұрады");
});

test("the digest stays bounded", () => {
  const digest = buildHandoffDigest({
    activeOrder: { display_number: 61 },
    customerProfile: { self_introduced_name: "Бекзат", complaint_count: 9, preferences: ["самовывоз", "донер"] },
    conversationSummary: { summary: "Ұзақ ".repeat(200) },
  } as any, "Ұзақ себеп ".repeat(80));

  assert.ok(digest.length <= 700, `digest was ${digest.length}`);
});

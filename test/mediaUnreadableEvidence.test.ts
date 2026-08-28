import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ROUTE = new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url);
const ROUTING = new URL("../src/services/complaintRouting.service.ts", import.meta.url);

/**
 * Money the guest has already sent must never end at "try again later".
 *
 * The owner's incident, 2026-08-28: a receipt arrived, every media channel failed
 * (five retired Gemini models, then an OpenRouter 402), and the guest was told to
 * send the file again later. Nobody was told a payment might be sitting unread. In
 * production that is the worst possible failure - the guest has paid and believes
 * the order is moving.
 *
 * So an unreadable file that could be payment evidence takes a second lane: the
 * operator gets a case with the file attached and checks it by hand.
 */
test("an unreadable image or PDF is handed to a human, not dropped", async () => {
  const source = await readFile(ROUTE, "utf8");
  const lane = source.slice(
    source.indexOf("if (mediaDeveloperError && !mediaDeveloperErrorIsUserInput)"),
    source.indexOf("if (immediateComplaintSummary)")
  );

  assert.ok(lane, "the technical-error lane is present");
  assert.match(lane, /mediaUnreadableEvidence && mediaContext/);
  assert.match(lane, /source: "media_unreadable_evidence"/);
  // The file itself has to travel with the case, or the operator has nothing to read.
  assert.match(lane, /base64: evidenceBase64/);
  assert.match(lane, /urgency: "high"/);
  // The developer alert still fires first: this lane adds a path, it removes none.
  assert.ok(lane.indexOf("notifyDeveloperSystemFailure") < lane.indexOf("mediaUnreadableEvidence && mediaContext"));
});

test("the guest is only promised a human when the case actually exists", async () => {
  const source = await readFile(ROUTE, "utf8");
  const lane = source.slice(
    source.indexOf("if (mediaUnreadableEvidence && mediaContext)"),
    source.indexOf("if (immediateComplaintSummary)")
  );

  assert.match(lane, /evidenceRouting\.action === "operator_case_created"/);
  // Without a case the reply falls back to the plain retry line - an honest answer,
  // never an invented promise.
  assert.match(lane, /: mediaPreemptiveReply/);
  assert.match(lane, /handedOver \? "media_unreadable_escalated" : mediaPreemptiveSource/);
});

// A voice note is never a receipt, and a sticker never is either. Paging a human for
// those would train the operator to ignore the lane.
test("audio and stickers are excluded from the evidence lane", async () => {
  const source = await readFile(ROUTE, "utf8");
  const guard = source.slice(
    source.indexOf("mediaUnreadableEvidence = Boolean("),
    source.indexOf("mediaPreemptiveReply =", source.indexOf("mediaUnreadableEvidence = Boolean("))
  );

  assert.match(guard, /mediaContext\.base64/);
  assert.match(guard, /kind !== "audio"/);
  assert.match(guard, /kind !== "sticker"/);
});

// The menu-question skip exists to stop "суық суы бар ма?" becoming an SOS. It must
// not swallow a payment file: the caption on a receipt photo often names a dish.
test("the evidence lane cannot be swallowed by the menu-question skip", async () => {
  const source = await readFile(ROUTING, "utf8");
  const skip = source.slice(
    source.indexOf("const menuSkipApplies"),
    source.indexOf("if (menuSkipApplies")
  );

  assert.match(skip, /input\.source !== "media_unreadable_evidence"/);
  // The other money lane keeps its exemption too.
  assert.match(skip, /input\.source !== "payment_shortfall"/);
});

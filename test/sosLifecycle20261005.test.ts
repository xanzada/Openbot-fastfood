import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  canAutoResolveTechnicalSos,
  isTechnicalRecoveryCase,
  shouldPreserveExistingCase,
} from "../src/services/operatorCase.service.js";

process.env.REDIS_URL = "redis://127.0.0.1:1";

const complaint = { kind: "complaint", source: "ai_tool_escalate_to_admin", summary: "cold food" };
const timeout = { kind: "unresolved", source: "ai_unavailable", summary: "model timeout" };

test("a technical timeout never overwrites a real open complaint", () => {
  assert.equal(shouldPreserveExistingCase(complaint, timeout), true);
  assert.equal(shouldPreserveExistingCase(timeout, complaint), false);
});

test("only a purely technical SOS can be auto-resolved after recovery", () => {
  assert.equal(isTechnicalRecoveryCase(timeout), true);
  assert.equal(canAutoResolveTechnicalSos(timeout, timeout), true);
  assert.equal(canAutoResolveTechnicalSos(timeout, complaint), false);
  assert.equal(canAutoResolveTechnicalSos(complaint, timeout), false);
});

test("a calm menu question on the ai-unavailable lane cannot bypass the menu SOS guard", async () => {
  const source = await readFile(new URL("../src/services/complaintRouting.service.ts", import.meta.url), "utf8");
  const gate = source.slice(source.indexOf("const menuSkipApplies"), source.indexOf("if (menuSkipApplies"));
  assert.doesNotMatch(gate, /input\.source !== "ai_unavailable"/);
});

test("ordinary successful replies settle only technical SOS instead of re-bumping every case", async () => {
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  assert.match(source, /resolveTechnicalSosAfterRecovery/);
  assert.doesNotMatch(source, /bumpOperatorCaseSignal/);
  assert.match(source, /if \(source !== "ai_unavailable"\)/);
  assert.match(source, /if \(!operatorEscalated\)/);
});

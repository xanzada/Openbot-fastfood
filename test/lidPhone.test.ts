import test from "node:test";
import assert from "node:assert/strict";
import {
  extractPhoneCandidate,
  normalizePhone,
  normalizePhoneFromCandidates,
  toWhatsAppChatId,
} from "../src/services/dle.service.js";
import { testModeAllowedPhones } from "../src/services/inboundGuard.service.js";

test("WhatsApp privacy LIDs survive OpenBot normalization", () => {
  const lid = "63037268607157@lid";
  assert.equal(extractPhoneCandidate(lid), lid);
  assert.equal(normalizePhone(lid), lid);
  assert.equal(normalizePhoneFromCandidates(["status@broadcast", lid]), lid);
  assert.equal(toWhatsAppChatId(lid), lid);
});

test("ordinary Kazakhstan phones and group rejection stay unchanged", () => {
  assert.equal(normalizePhone("8 (776) 915-61-84"), "77769156184");
  assert.equal(normalizePhone("+7 776 915 61 84"), "77769156184");
  assert.equal(normalizePhone("120363000000000@g.us"), "");
});

test("test mode can allow one exact developer LID without allowing strangers", () => {
  const developerLid = "63037268607157@lid";
  const allowed = testModeAllowedPhones({ dev_phone: developerLid }, {});
  assert.equal(allowed.has(developerLid), true);
  assert.equal(allowed.has("99999999999999@lid"), false);
});

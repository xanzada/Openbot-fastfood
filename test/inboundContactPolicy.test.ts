import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateTenantContactRules,
  matchesIgnoredContactEntry,
  type TenantContactPolicy,
} from "../src/services/inboundGuard.service.js";

function decide(policy: TenantContactPolicy | null, senderMeta?: Record<string, any>, phone = "77001112233") {
  return evaluateTenantContactRules({ phone, senderMeta, contactPolicy: policy });
}

test("an ignored phone is invisible, whichever way the number is written", () => {
  const policy: TenantContactPolicy = { ignoredContacts: ["+7 701 555 66 77"] };
  assert.equal(decide(policy, {}, "77015556677")?.reason, "ignored_contact");
  assert.equal(decide(policy, {}, "87015556677")?.reason, "ignored_contact");
  assert.equal(decide(policy, {}, "77021112233"), null);
});

test("an ignored name matches the saved-contact identity, not the message text", () => {
  const policy: TenantContactPolicy = { ignoredContacts: ["мама"] };
  assert.equal(decide(policy, { contactName: "Мама", isMyContact: true })?.reason, "ignored_contact");
  // A guest typing the word must still be served.
  assert.equal(decide(policy), null);
});

test("the unsaved switch silences strangers and leaves saved guests alone", () => {
  const policy: TenantContactPolicy = { allowUnsavedContacts: false, allowSavedContacts: true };
  assert.equal(decide(policy, { isMyContact: false })?.reason, "unsaved_contact_policy");
  assert.equal(decide(policy, { isMyContact: true }), null);
});

test("the saved switch silences the owner's own contacts", () => {
  const policy: TenantContactPolicy = { allowSavedContacts: false, allowUnsavedContacts: true };
  assert.equal(decide(policy, { isMyContact: true })?.reason, "private_saved_contact");
  assert.equal(decide(policy, { isMyContact: false }), null);
});

test("a tenant without any policy keeps the platform-wide behaviour", () => {
  // BOT_IGNORE_SAVED_CONTACTS defaults to true, so a saved sender stays blocked
  // exactly as before this feature existed.
  assert.equal(decide(null, { isMyContact: true })?.reason, "private_saved_contact");
  assert.equal(decide(null, { isMyContact: false }), null);
});

test("entry matching details", () => {
  assert.equal(matchesIgnoredContactEntry("Папа", "77001112233", { contactName: "Папа работа" }), true);
  assert.equal(matchesIgnoredContactEntry("апа", "77001112233", { contactName: "Папа" }), false);
  assert.equal(matchesIgnoredContactEntry("77001112233", "+7 700 111 22 33", {}), true);
  assert.equal(matchesIgnoredContactEntry("", "", {}), false);
});

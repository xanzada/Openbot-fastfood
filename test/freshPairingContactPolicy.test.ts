import test from "node:test";
import assert from "node:assert/strict";
import { evaluateTenantContactRules, extractSenderMeta } from "../src/services/inboundGuard.service.js";

/**
 * The owner changed kabab #1's WhatsApp number, scanned a fresh QR, and the bot went
 * completely silent (2026-08-30). Every real guest was dropped as
 * "unsaved_contact_policy".
 *
 * The tenant serves only saved contacts (allow_unsaved_contacts:false), and a FRESH
 * pairing has no address book at all: Baileys fills its contact map from
 * contacts.upsert/update, and with syncFullHistory:false those events may never come.
 * So isMyContact:false meant "we cannot tell", but the guard read it as "stranger".
 */
const SAVED_ONLY = { allowSavedContacts: true, allowUnsavedContacts: false };

test("a fresh pairing with no address book serves the guest instead of going silent", () => {
  const verdict = evaluateTenantContactRules({
    phone: "77476884956",
    senderMeta: { isMyContact: false, addressBookKnown: false, pushName: "Xanzada" },
    contactPolicy: SAVED_ONLY,
  });

  assert.equal(verdict, null, "an unclassifiable guest is answered, not dropped");
});

test("once the address book IS known, the saved-only policy blocks strangers again", () => {
  const verdict = evaluateTenantContactRules({
    phone: "77001112233",
    senderMeta: { isMyContact: false, addressBookKnown: true },
    contactPolicy: SAVED_ONLY,
  });

  assert.deepEqual(verdict, { blocked: true, reason: "unsaved_contact_policy" });
});

test("a recognised saved contact passes whether or not the book was loaded", () => {
  for (const addressBookKnown of [true, false]) {
    assert.equal(
      evaluateTenantContactRules({
        phone: "77476884956",
        senderMeta: { isMyContact: true, addressBookKnown },
        contactPolicy: SAVED_ONLY,
      }),
      null,
      `saved contact with addressBookKnown=${addressBookKnown}`
    );
  }
});

// The other direction must not move: a tenant that deliberately ignores its own saved
// contacts (prestige runs this way) still ignores them, because a positive recognition
// is a fact regardless of how complete the book is.
test("the private-saved-contact rule is untouched by the unknown-book escape", () => {
  const verdict = evaluateTenantContactRules({
    phone: "77769156184",
    senderMeta: { isMyContact: true, addressBookKnown: false },
    contactPolicy: { allowSavedContacts: false, allowUnsavedContacts: true },
  });

  assert.deepEqual(verdict, { blocked: true, reason: "private_saved_contact" });
});

test("the ignore list still wins, book or no book", () => {
  const verdict = evaluateTenantContactRules({
    phone: "77473620384",
    senderMeta: { isMyContact: false, addressBookKnown: false },
    contactPolicy: { ...SAVED_ONLY, ignoredContacts: ["+77473620384"] },
  });

  assert.deepEqual(verdict, { blocked: true, reason: "ignored_contact" });
});

// Backwards compatibility: an older gateway that does not send the flag must behave
// exactly as before, or one deploy would start serving strangers to every saved-only
// tenant on the platform.
test("a payload without the flag is treated as a known book", () => {
  const verdict = evaluateTenantContactRules({
    phone: "77001112233",
    senderMeta: { isMyContact: false },
    contactPolicy: SAVED_ONLY,
  });

  assert.deepEqual(verdict, { blocked: true, reason: "unsaved_contact_policy" });
});

test("extractSenderMeta reads the flag from every shape the gateway sends", () => {
  assert.equal(extractSenderMeta({ data: { addressBookKnown: false } }).addressBookKnown, false);
  assert.equal(extractSenderMeta({ addressBookKnown: false }).addressBookKnown, false);
  assert.equal(extractSenderMeta({ data: { contact: { addressBookKnown: false } } }).addressBookKnown, false);
  assert.equal(extractSenderMeta({ contact: { addressBookKnown: false } }).addressBookKnown, false);
  // Absent means "assume known" - the wwebjs transport always carries the real book.
  assert.equal(extractSenderMeta({ data: { isMyContact: true } }).addressBookKnown, true);
  assert.equal(extractSenderMeta({}).addressBookKnown, true);
});

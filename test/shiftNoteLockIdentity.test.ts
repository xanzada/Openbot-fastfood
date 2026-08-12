import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractShiftNotePayload } from "../src/controllers/kanban.js";

// Live inbound sweep, 2026-08-11: shift_note.created followed by
// shift_note.updated for the same note id was answered "Ignored duplicate
// signal", because the 5s idempotency lock was keyed on the note id alone. The
// kitchen's correction never reached the AI memory.
test("an edited note is not mistaken for a redelivery of the original", () => {
  const created = extractShiftNotePayload({ action: "shift_note_created", note_id: "note-1", text: "кола жоқ" });
  const edited = extractShiftNotePayload({ action: "shift_note_created", note_id: "note-1", text: "кола бар" });
  assert.notEqual(created.stableLockId, edited.stableLockId);
  assert.equal(created.noteId, "note-1");
  assert.equal(edited.noteId, "note-1");
});

// normalizeDlePayload spreads the envelope over the body, so a top-level `id` is
// the id of the EVENT, not of the note (the note's own id arrives as note_id,
// already resolved from note.id upstream). Storing under the event id gave every
// redelivery a fresh key and left the matching delete nothing to match.
test("the event id never becomes the note key", () => {
  const payload = extractShiftNotePayload({ action: "shift_note_created", id: "evt-4412", text: "кола жоқ" });
  assert.equal(payload.noteId, "");
  assert.match(payload.stableLockId, /^fallback_/);
});

test("the same note delivered twice still collapses to one lock", () => {
  const first = extractShiftNotePayload({ action: "shift_note_created", note_id: "note-7", text: "тек қолма-қол" });
  const retry = extractShiftNotePayload({ action: "shift_note_created", note_id: "note-7", text: "тек қолма-қол" });
  assert.equal(first.stableLockId, retry.stableLockId);
});

test("an expiry change is a real change, and duplicate deletes stay deduped", () => {
  const short = extractShiftNotePayload({ note_id: "note-9", text: "кеш жабамыз", expires_at: "1786470000000" });
  const long = extractShiftNotePayload({ note_id: "note-9", text: "кеш жабамыз", expires_at: "1786480000000" });
  assert.notEqual(short.stableLockId, long.stableLockId);

  const del = extractShiftNotePayload({ action: "shift_note_deleted", note_id: "note-9" });
  const delAgain = extractShiftNotePayload({ action: "shift_note_deleted", note_id: "note-9" });
  assert.equal(del.stableLockId, delAgain.stableLockId);
});

test("a note with no id still locks on its content, not on a shared key", () => {
  const a = extractShiftNotePayload({ action: "shift_note_created", text: "суши бітті" });
  const b = extractShiftNotePayload({ action: "shift_note_created", text: "пицца бітті" });
  assert.match(a.stableLockId, /^fallback_/);
  assert.notEqual(a.stableLockId, b.stableLockId);
});

// The delete route used to answer 200 "Note removed from AI memory" whatever
// happened - including when it identified no note and removed nothing - so an
// operator watching the panel believed a stale constraint was gone while the bot
// kept applying it until the TTL ran out.
test("a delete reports what it actually removed", async () => {
  const source = await readFile(new URL("../src/controllers/kanban.ts", import.meta.url), "utf8");
  const branch = source.slice(source.indexOf('action === "shift_note_deleted"'));
  const body = branch.slice(0, 1400);
  assert.match(body, /!shiftNotePayload\.noteId && !shiftNotePayload\.text\.trim\(\)/);
  assert.match(body, /NOTE_ID_OR_TEXT_REQUIRED/);
  assert.match(body, /const deleted = await deleteShiftNote\(/);
  assert.match(body, /deleted \? "Note removed from AI memory" : "No matching note found in AI memory"/);
});

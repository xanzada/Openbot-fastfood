import test from "node:test";
import assert from "node:assert/strict";
import { extractShiftNotePayload } from "../src/controllers/kanban.js";

// Live inbound sweep, 2026-08-11: shift_note.created followed by
// shift_note.updated for the same note id was answered "Ignored duplicate
// signal", because the 5s idempotency lock was keyed on the note id alone. The
// kitchen's correction never reached the AI memory.
test("an edited note is not mistaken for a redelivery of the original", () => {
  const created = extractShiftNotePayload({ action: "shift_note_created", id: "note-1", text: "кола жоқ" });
  const edited = extractShiftNotePayload({ action: "shift_note_created", id: "note-1", text: "кола бар" });
  assert.notEqual(created.stableLockId, edited.stableLockId);
  assert.equal(created.noteId, "note-1");
  assert.equal(edited.noteId, "note-1");
});

test("the same note delivered twice still collapses to one lock", () => {
  const first = extractShiftNotePayload({ action: "shift_note_created", note_id: "note-7", text: "тек қолма-қол" });
  const retry = extractShiftNotePayload({ action: "shift_note_created", note_id: "note-7", text: "тек қолма-қол" });
  assert.equal(first.stableLockId, retry.stableLockId);
});

test("an expiry change is a real change, and duplicate deletes stay deduped", () => {
  const short = extractShiftNotePayload({ id: "note-9", text: "кеш жабамыз", expires_at: "1786470000000" });
  const long = extractShiftNotePayload({ id: "note-9", text: "кеш жабамыз", expires_at: "1786480000000" });
  assert.notEqual(short.stableLockId, long.stableLockId);

  const del = extractShiftNotePayload({ action: "shift_note_deleted", id: "note-9" });
  const delAgain = extractShiftNotePayload({ action: "shift_note_deleted", id: "note-9" });
  assert.equal(del.stableLockId, delAgain.stableLockId);
});

test("a note with no id still locks on its content, not on a shared key", () => {
  const a = extractShiftNotePayload({ action: "shift_note_created", text: "суши бітті" });
  const b = extractShiftNotePayload({ action: "shift_note_created", text: "пицца бітті" });
  assert.match(a.stableLockId, /^fallback_/);
  assert.notEqual(a.stableLockId, b.stableLockId);
});

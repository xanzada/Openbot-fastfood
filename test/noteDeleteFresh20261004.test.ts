import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { withoutDeletedNotes, redisClient } = await import("../src/services/redis.service.js");
test.after(() => { if (redisClient.isOpen) redisClient.destroy(); });

// Live test 2026-10-04: «суши жоқ» deleted on the site, the next answer still said
// sushi was unavailable - the 30 s runtime snapshot still listed the note.
test("a deleted note is dropped from any note list by id or exact text", () => {
  const notes = [
    { noteId: "n-sushi", text: "Суши жоқ пока что" },
    { id: "n-drinks", text: "Кола бітті" },
    { note_id: "n-other", text: "Курьер кешігеді" },
  ];
  assert.deepEqual(withoutDeletedNotes(notes, new Set(["n-sushi"])).map((n: any) => n.text), ["Кола бітті", "Курьер кешігеді"]);
  assert.deepEqual(withoutDeletedNotes(notes, new Set(), "кола бітті").map((n: any) => n.text), ["Суши жоқ пока что", "Курьер кешігеді"]);
  assert.equal(withoutDeletedNotes(notes, new Set()).length, 3);
});

test("the delete webhook forgets the note everywhere; edits refresh the snapshot", async () => {
  const kanban = await readFile(new URL("../src/controllers/kanban.ts", import.meta.url), "utf8");
  const del = kanban.indexOf("await deleteShiftNote(instance");
  assert.ok(del > 0);
  assert.ok(kanban.indexOf("forgetDeletedShiftNote(instance", del) > del, "forget runs right after the delete");
  assert.match(kanban, /refreshAfterShiftNoteSaved\(instance, shiftNotePayload\.noteId\)/, "a saved/edited note drops the stale snapshot");
  const preload = await readFile(new URL("../src/context/preloadContext.ts", import.meta.url), "utf8");
  assert.match(preload, /withoutDeletedNotes\(mergeShiftNoteSources\(/);
  assert.match(preload, /getDeletedShiftNoteIds\(instanceId\)/);
  const redis = await readFile(new URL("../src/services/redis.service.ts", import.meta.url), "utf8");
  const sync = redis.slice(redis.indexOf("export async function syncShiftNotesSnapshot"));
  assert.match(sync.slice(0, 900), /deleted\.has\(noteId\)/, "a stale hub snapshot cannot resurrect a deleted note");
});

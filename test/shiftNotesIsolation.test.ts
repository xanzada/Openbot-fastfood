import test from "node:test";
import assert from "node:assert/strict";
import { redisClient } from "../src/services/redis.service.js";
import { saveShiftNote, deleteShiftNote, getActiveShiftNotes, syncShiftNotesSnapshot } from "../src/services/redis.service.js";

// The shift-note helpers talk to the module-level client directly, so the test
// swaps that client's methods for an in-memory store. Everything under test is
// the real production function, including the key names it builds.
const store = new Map<string, string>();
const lists = new Map<string, string[]>();

function match(pattern: string, key: string) {
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(key);
}

Object.defineProperty(redisClient, "isOpen", { get: () => true, configurable: true });
(redisClient as any).connect = async () => undefined;
(redisClient as any).setEx = async (key: string, _ttl: number, value: string) => { store.set(key, value); return "OK"; };
(redisClient as any).get = async (key: string) => store.get(key) ?? null;
(redisClient as any).del = async (key: string) => (store.delete(key) ? 1 : 0);
(redisClient as any).ttl = async () => -1;
(redisClient as any).lRange = async (key: string) => lists.get(key) ?? [];
(redisClient as any).expire = async () => 1;
(redisClient as any).multi = () => {
  const ops: Array<() => void> = [];
  const chain: any = {
    del: (key: string) => { ops.push(() => lists.delete(key)); return chain; },
    rPush: (key: string, row: string) => { ops.push(() => lists.set(key, [...(lists.get(key) ?? []), row])); return chain; },
    exec: async () => { ops.forEach((op) => op()); return []; },
  };
  return chain;
};
(redisClient as any).scanIterator = async function* ({ MATCH }: { MATCH: string }) {
  for (const key of [...store.keys(), ...lists.keys()]) if (match(MATCH, key)) yield key;
};

const A = "prestige";
const B = "other-resto";

async function seed() {
  store.clear();
  lists.clear();
  await saveShiftNote(A, "101", "Ірімшік бітті");
  await saveShiftNote(A, "102", "Кешкі кезек ұзақ");
  await saveShiftNote(B, "201", "Тек өзі алып кету");
}

test("a note is stored under its own tenant and read back only for that tenant", async () => {
  await seed();

  assert.ok(store.has(`shift_note:${A}:101`), "key must carry the instance id");
  assert.ok(store.has(`shift_note:${B}:201`));

  const a = await getActiveShiftNotes(A);
  const b = await getActiveShiftNotes(B);
  assert.deepEqual(a.map((n) => n.text).sort(), ["Ірімшік бітті", "Кешкі кезек ұзақ"]);
  assert.deepEqual(b.map((n) => n.text), ["Тек өзі алып кету"]);
});

test("deleting one note by id leaves the other tenant untouched", async () => {
  await seed();
  await deleteShiftNote(A, "101");

  assert.equal(store.has(`shift_note:${A}:101`), false, "the targeted note is gone");
  assert.equal(store.has(`shift_note:${A}:102`), true, "the sibling note survives");
  assert.equal(store.has(`shift_note:${B}:201`), true, "the other restaurant is never touched");
});

test("deleting by text matches inside the tenant only", async () => {
  await seed();
  // Same text exists in both tenants: the delete must stay inside A.
  await saveShiftNote(B, "202", "Ірімшік бітті");
  await deleteShiftNote(A, "", "Ірімшік бітті");

  assert.equal(store.has(`shift_note:${A}:101`), false);
  assert.equal(store.has(`shift_note:${B}:202`), true, "identical text in another tenant must survive");
});

test("a delete that names no note removes nothing at all", async () => {
  await seed();
  // A malformed webhook must not be able to erase a shift. Without an id or an
  // exact text there is no target, so nothing is touched anywhere.
  await deleteShiftNote(A, "", "");

  assert.equal(await getActiveShiftNotes(A).then((n) => n.length), 2, "this tenant keeps every note");
  assert.equal(store.has(`shift_note:${B}:201`), true, "the other restaurant keeps its notes");
});

test("an unknown id or unmatched text deletes nothing", async () => {
  await seed();
  await deleteShiftNote(A, "999");
  await deleteShiftNote(A, "", "мұндай ескертпе жоқ");

  assert.equal(await getActiveShiftNotes(A).then((n) => n.length), 2);
  assert.equal(store.has(`shift_note:${B}:201`), true);
});

test("an expired note is never served to the agent and is cleaned up", async () => {
  store.clear();
  lists.clear();
  store.set(
    `shift_note:${A}:900`,
    JSON.stringify({ text: "Ескірген ескерту", createdAt: Date.now() - 7200_000, expiresAt: Date.now() - 3600_000 })
  );
  await saveShiftNote(A, "901", "Жарамды ескерту");

  const notes = await getActiveShiftNotes(A);
  assert.deepEqual(notes.map((n) => n.text), ["Жарамды ескерту"]);
  assert.equal(store.has(`shift_note:${A}:900`), false, "the expired key is removed on read");
});

test("history purge after a delete stays inside the tenant", async () => {
  await seed();
  lists.set(`history:${A}:77010000001`, [
    JSON.stringify({ text: "ескерту хабары", sourceNoteIds: ["101"] }),
    JSON.stringify({ text: "кәдімгі хабар" }),
  ]);
  lists.set(`history:${B}:77020000002`, [JSON.stringify({ text: "бөтен ескерту", sourceNoteIds: ["101"] })]);

  await deleteShiftNote(A, "101");

  assert.deepEqual(
    (lists.get(`history:${A}:77010000001`) ?? []).map((r) => JSON.parse(r).text),
    ["кәдімгі хабар"],
    "the note-derived message is pulled from this tenant's history"
  );
  assert.equal(
    (lists.get(`history:${B}:77020000002`) ?? []).length,
    1,
    "a message carrying the same note id in another tenant is left alone"
  );
});

// A deleted note used to live on inside the rolling summary, which is written
// from history and fed back into the prompt, so the agent kept repeating a
// constraint the operator had already removed.
test("deleting a note also drops the summary written from that history", async () => {
  await seed();
  lists.set(`history:${A}:77010000001`, [
    JSON.stringify({ text: "сусын жоқ дедім", sourceNoteIds: ["101"] }),
    JSON.stringify({ text: "кәдімгі хабар" }),
  ]);
  store.set(`conv_summary:${A}:77010000001`, JSON.stringify({ summary: "drinks were unavailable" }));
  store.set(`conv_summary:${B}:77020000002`, JSON.stringify({ summary: "other tenant memory" }));

  await deleteShiftNote(A, "101");

  assert.equal(
    store.has(`conv_summary:${A}:77010000001`),
    false,
    "the stale summary is dropped so the next turn rebuilds it without the deleted note"
  );
  assert.equal(
    store.has(`conv_summary:${B}:77020000002`),
    true,
    "another tenant's summary is untouched"
  );
});

test("a summary survives when the delete removed nothing from that history", async () => {
  await seed();
  lists.set(`history:${A}:77010000001`, [JSON.stringify({ text: "кәдімгі хабар" })]);
  store.set(`conv_summary:${A}:77010000001`, JSON.stringify({ summary: "nothing to do with notes" }));

  await deleteShiftNote(A, "101");

  assert.equal(
    store.has(`conv_summary:${A}:77010000001`),
    true,
    "an unrelated conversation keeps its memory"
  );
});

test("the authoritative runtime snapshot restores missed notes and removes stale ones", async () => {
  await seed();
  await syncShiftNotesSnapshot(A, [{
    id: "runtime-301",
    text: "Кола закончилась, предлагай пепси",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  }]);

  const notes = await getActiveShiftNotes(A);
  assert.deepEqual(notes.map((note) => note.noteId), ["runtime-301"]);
  assert.equal(notes[0].text, "Кола закончилась, предлагай пепси");
  assert.equal(store.has(`shift_note:${B}:201`), true, "another tenant is untouched");
});

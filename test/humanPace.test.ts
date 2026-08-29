import test from "node:test";
import assert from "node:assert/strict";
import { planHumanPacing, regroupBySentence, typingTimeMs } from "../src/transport/humanPace.js";

// A fixed random makes the arithmetic assertable; the production path uses Math.random.
const mid = () => 0.5;

/**
 * The bot answered instantly and in one push, which is the clearest possible tell that
 * nobody is on the other side (owner request, 2026-08-29).
 */
test("typing time grows with the text and stays inside its bounds", () => {
  const short = typingTimeMs("Иә, бар.", mid);
  const long = typingTimeMs("Донер 1590 теңге, ішінде тауық еті, көкөніс және соус бар.", mid);

  assert.ok(short > 0);
  assert.ok(long > short, "a longer message must take longer to type");
  // The floor keeps a two-word reply from arriving instantly; the cap keeps a long one
  // from holding the guest.
  assert.ok(short >= 550);
  assert.ok(long <= 6500);
  assert.equal(typingTimeMs("", mid), 0);
  assert.equal(typingTimeMs("   ", mid), 0);
});

test("the first message waits for reading plus typing, later ones only for typing", () => {
  const pacing = planHumanPacing(["Бірінші хабар.", "Екінші хабар."], "normal", mid);

  assert.equal(pacing.typingMs.length, 2);
  assert.ok(pacing.readPauseMs > 0, "there is a beat before the bot starts writing");
  assert.ok(pacing.typingMs.every((value) => value > 0));
  assert.equal(pacing.totalMs, pacing.readPauseMs + pacing.typingMs.reduce((sum, value) => sum + value, 0));
});

// Speed IS the courtesy for an angry guest or an escalation - they must not watch a
// typing performance.
test("an urgent turn collapses the pauses, a calm one keeps them", () => {
  const chunks = ["Кешіріңіз, тексеріп жатырмын.", "Операторға бердім."];
  const urgent = planHumanPacing(chunks, "urgent", mid);
  const normal = planHumanPacing(chunks, "normal", mid);
  const calm = planHumanPacing(chunks, "calm", mid);

  assert.ok(urgent.totalMs < normal.totalMs);
  assert.ok(normal.totalMs < calm.totalMs);
  // Still nonzero, so the reply lands after the "typing…" indicator rather than before it.
  assert.ok(urgent.totalMs > 0);
});

test("a very long reply is clamped to the total budget, keeping its shape", () => {
  const long = Array.from({ length: 8 }, (_, index) => `${"Ұзақ сөйлем ".repeat(20)}${index}.`);
  const pacing = planHumanPacing(long, "calm", mid);

  assert.ok(pacing.totalMs <= 14_000, `total was ${pacing.totalMs}`);
  // Proportional scaling, not truncation: every message still has its own beat.
  assert.equal(pacing.typingMs.length, long.length);
  assert.ok(pacing.typingMs.every((value) => value >= 120));
});

test("no chunks means no waiting at all", () => {
  assert.deepEqual(planHumanPacing([], "normal", mid), { readPauseMs: 0, typingMs: [], totalMs: 0 });
  assert.deepEqual(planHumanPacing(["", "  "], "normal", mid), { readPauseMs: 0, typingMs: [], totalMs: 0 });
});

// "сөйлемді аяқтап" - the owner's words. The size-based chunker cuts on a character
// budget, so a long sentence could be torn in half and a fragment arrived alone.
test("a sentence is never split across two messages", () => {
  const torn = ["Донер 1590 теңге, ішінде тауық еті,", "көкөніс және соус бар."];
  const fixed = regroupBySentence(torn, 320);

  assert.equal(fixed.length, 1);
  assert.equal(fixed[0], "Донер 1590 теңге, ішінде тауық еті, көкөніс және соус бар.");
});

test("messages that already end on a sentence are left as separate messages", () => {
  const clean = ["Иә, жұмыс істеп тұрмыз.", "Не әкелейін?"];
  assert.deepEqual(regroupBySentence(clean, 320), clean);
});

test("a link always stays its own message", () => {
  const withLink = ["Мәзірді жібердім.", "https://kebab1.alemi.kz/?phone=77010000001&hash=ab"];
  assert.deepEqual(regroupBySentence(withLink, 320), withLink);

  // Even after an unfinished sentence, the URL is not glued to prose.
  const unfinished = ["Мәзір мынау", "https://kebab1.alemi.kz/?phone=77010000001&hash=ab"];
  assert.deepEqual(regroupBySentence(unfinished, 320), unfinished);
});

test("merging never pushes a message past the size limit", () => {
  const a = "а".repeat(200);
  const b = "б".repeat(200) + ".";
  const out = regroupBySentence([a, b], 320);

  assert.equal(out.length, 2, "two fragments that cannot fit stay apart rather than exceed the limit");
});

test("one enormous sentence with no terminator is sent as it is", () => {
  // Nothing to merge it with, and truncating a fact to make the shape neat would be
  // worse than an ugly message.
  const single = ["бір өте ұзақ сөйлем нүктесі жоқ"];
  assert.deepEqual(regroupBySentence(single, 320), single);
});

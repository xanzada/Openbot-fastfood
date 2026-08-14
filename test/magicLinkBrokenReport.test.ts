import assert from "node:assert/strict";
import test from "node:test";
import { hasBrokenLinkReport } from "../src/utils/magicLink.js";

test("a link word plus a broken word is always a broken-link report", () => {
  assert.equal(hasBrokenLinkReport("Сілтеме ашылмай тұр"), true);
  assert.equal(hasBrokenLinkReport("Ссылка не работает"), true);
  assert.equal(hasBrokenLinkReport("Сілтеме жарамсыз болып қалды"), true);
});

test("a bare short report counts when a link sits in recent history", () => {
  const history = ["Тапсырыс берейін деп едім", "Міне мәзір сілтемесі:\nhttps://x.alemi.kz/auth/whatsapp#token=abc"];
  assert.equal(hasBrokenLinkReport("Ол жасамай қалды", history), true);
  assert.equal(hasBrokenLinkReport("Он не открывается", history), true);
});

test("a bare report with no link anywhere is not a link request", () => {
  assert.equal(hasBrokenLinkReport("Ол жасамай қалды", ["Сәлем", "Сәлем! Қалай көмектесе аламын?"]), false);
  assert.equal(hasBrokenLinkReport("Жұмыс істемей қалды"), false);
});

test("a long text without a link word is not forced into a link request", () => {
  const history = ["https://x.alemi.kz/auth/whatsapp#token=abc"];
  const longText = "Ас үй жұмыс істемей тұр деп ойлаймын, өйткені тапсырысым екі сағат бойы келмей қалды, кассир де жауап бермейді, не істеуім керек екенін айтыңызшы өтінемін";
  assert.equal(hasBrokenLinkReport(longText, history), false);
});

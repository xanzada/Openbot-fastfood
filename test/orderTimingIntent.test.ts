import test from "node:test";
import assert from "node:assert/strict";
import { isOrderTimingQuestion } from "../src/utils/orderIntent.js";

test("a guest asking how long the food takes is a timing question", () => {
  assert.equal(isOrderTimingQuestion("қанша уақытта жетеді?"), true);
  assert.equal(isOrderTimingQuestion("kansha uakytta jetedi"), true);
  assert.equal(isOrderTimingQuestion("через сколько привезете"), true);
  assert.equal(isOrderTimingQuestion("как долго ждать"), true);
});

test("ordinary menu talk is not a timing question", () => {
  assert.equal(isOrderTimingQuestion("мәзірде не бар"), false);
  assert.equal(isOrderTimingQuestion("цезарь қанша тұрады"), false);
});

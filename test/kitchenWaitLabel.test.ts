import test from "node:test";
import assert from "node:assert/strict";
import { formatKitchenWait } from "../src/services/kitchenPolicy.service.js";

// The operator panel offers only 0 / 60 / 120, and guests read those as hours.
test("the two values an operator can set are spoken as hours", () => {
  assert.equal(formatKitchenWait(60, "kk"), "1 сағат");
  assert.equal(formatKitchenWait(60, "ru"), "1 час");
  assert.equal(formatKitchenWait(120, "kk"), "2 сағат");
  assert.equal(formatKitchenWait(120, "ru"), "2 часа");
});

test("Russian hour plurals stay correct further up the scale", () => {
  assert.equal(formatKitchenWait(180, "ru"), "3 часа");
  assert.equal(formatKitchenWait(300, "ru"), "5 часов");
  assert.equal(formatKitchenWait(300, "kk"), "5 сағат");
});

test("a value that is not a whole hour keeps its minutes rather than being rounded away", () => {
  assert.equal(formatKitchenWait(90, "kk"), "1 сағат 30 минут");
  assert.equal(formatKitchenWait(90, "ru"), "1 час 30 минут");
});

test("under an hour stays in minutes, and zero is never dressed up", () => {
  assert.equal(formatKitchenWait(45, "kk"), "45 минут");
  assert.equal(formatKitchenWait(0, "kk"), "0 минут");
  assert.equal(formatKitchenWait(0, "ru"), "0 минут");
});

import test from "node:test";
import assert from "node:assert/strict";
import { decideCaseFlag, CASE_FLAG_QUIET_MS } from "../src/services/operatorCase.service.js";

const NOW = 1_700_000_000_000;

test("a fresh open case raises its red flag once", () => {
  assert.equal(decideCaseFlag({ createdAt: NOW - 60_000, updatedAt: NOW - 60_000 }, NOW), "flag");
});

test("a case already on the board never raises a second flag when the chat scrolls", () => {
  // The old code looked for the marker in the last 40 history entries, so an
  // ordinary conversation eventually pushed it out of view and the panel lit
  // up red again with wording the guest had never used in that turn.
  const data = { createdAt: NOW - 60_000, updatedAt: NOW - 60_000, markerPushedAt: NOW - 30_000 };
  assert.equal(decideCaseFlag(data, NOW), "already_flagged");
});

test("a case nobody touched for half a day stops flagging a guest who moved on", () => {
  const data = { createdAt: NOW - 31 * 60 * 60 * 1000, updatedAt: NOW - 31 * 60 * 60 * 1000 };
  assert.equal(decideCaseFlag(data, NOW), "stale");
});

test("a case touched just inside the quiet window is still live", () => {
  const data = { createdAt: NOW - 40 * 60 * 60 * 1000, updatedAt: NOW - (CASE_FLAG_QUIET_MS - 60_000) };
  assert.equal(decideCaseFlag(data, NOW), "flag");
});

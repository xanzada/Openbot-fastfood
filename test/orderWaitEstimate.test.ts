import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { customerOrderFromRecord, formatCustomerOrderStatus, orderWaitLine } from "../src/services/customerOrder.service.js";

function order(status: string) {
  const lookup = customerOrderFromRecord(
    { id: "77", phone: "77001234567", status, items: [{ name: "Пицца", qty: 1 }] },
    "77001234567",
    "ru",
  );
  assert.equal(lookup.state, "found");
  if (lookup.state !== "found") throw new Error("unreachable");
  return lookup.order;
}

// A paid order is the one the kitchen is actually cooking.
const cooking = "paid";

// The status line used to end at "we will write the moment it is ready" even when
// the kitchen had entered 65 minutes, so the one number the guest actually wanted
// was held by the backend and never said out loud (audit, 2026-08-12).
test("a status answer names the kitchen's own estimate while the food is being made", () => {
  const line = orderWaitLine(order(cooking), "ru", 65);
  assert.match(line, /1 час 5 минут/u);
  assert.match(formatCustomerOrderStatus(order(cooking), "ru", 65), /1 час 5 минут/u);
});

test("the estimate is given in Kazakh too", () => {
  assert.match(orderWaitLine(order(cooking), "kk", 90), /1 сағат 30 минут/u);
});

test("no estimate is invented when the kitchen entered none", () => {
  assert.equal(orderWaitLine(order(cooking), "ru", 0), "");
  assert.equal(orderWaitLine(order(cooking), "ru", null), "");
  assert.equal(orderWaitLine(order(cooking), "ru", "abc"), "");
});

test("a cooking estimate is not repeated to a guest whose order is already on its way", () => {
  for (const status of ["delivery", "completed", "cancelled"]) {
    assert.equal(orderWaitLine(order(status), "ru", 65), "", status);
    assert.doesNotMatch(formatCustomerOrderStatus(order(status), "ru", 65), /1 час 5 минут/u);
  }
});

test("the status line still reads correctly with no wait argument at all", () => {
  assert.match(formatCustomerOrderStatus(order(cooking), "ru"), /Заказ #77/u);
});

// A wait of 35 was floored to 0 before storage because the sales policy calls
// anything up to 40 "normal" - so a guest asking "how long?" was told nothing and
// the panel looked like it had dropped the write (audit, 2026-08-12).
test("a wait the policy calls normal is still stored, not floored to zero", async () => {
  const source = await readFile(new URL("../src/services/redis.service.ts", import.meta.url), "utf8");
  const fn = source.slice(source.indexOf("function normalizeKitchenWaitTime"));
  const body = fn.slice(0, fn.indexOf("}") + 1);
  assert.match(body, /Math\.min\(720, Math\.max\(0, Math\.floor\(Number\(value \?\? 0\) \|\| 0\)\)\)/);
  assert.doesNotMatch(body, /< 41|<= 40|> 40 \?/);
});

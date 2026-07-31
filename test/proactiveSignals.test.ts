import test from "node:test";
import assert from "node:assert/strict";
import { orderSignature, statusWord } from "../src/services/proactiveSignals.service.js";

test("an order signature captures identity and state", () => {
  assert.equal(orderSignature({ id: "o1", status: "new" }), "o1|new");
  assert.equal(orderSignature({ order_number: "A-42", status: "cooking" }), "A-42|cooking");
  assert.equal(orderSignature(null), "");
  assert.equal(orderSignature({}), "");
});

test("status words collapse into customer-meaningful buckets", () => {
  assert.equal(statusWord({ status: "delivered" }), "delivered");
  assert.equal(statusWord({ status: "courier" }), "on_the_way");
  assert.equal(statusWord({ status: "готовится" }), "ready");
  assert.equal(statusWord({ status: "cancelled" }), "cancelled");
  assert.equal(statusWord({ status: "new" }), "");
  assert.equal(statusWord(null), "");
});

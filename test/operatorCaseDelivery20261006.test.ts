import assert from "node:assert/strict";
import test from "node:test";
import {lifecycleRedisEnabled, operatorLifecycleFixture} from "./helpers/operatorLifecycleFixture.js";
const options = {skip: !lifecycleRedisEnabled && "Requires disposable AUDIT_REDIS_SOCKET; Lua is exercised on real Redis."};
test("canonical operator case, SOS marker and both durable delivery plans exist before return", options, async () => {
  const h = await operatorLifecycleFixture();
  try {const result = await h.create(); assert.ok(result.id);
    assert.ok(await h.client.get(h.key("case", result.id))); assert.ok(await h.client.get(h.key("marker")));
    assert.equal(h.store.records.size, 2); assert.equal([...h.store.records.values()].every(row => row.status === "pending"), true);
  } finally {await h.close();}
});
test("updating one active case does not create another notification plan", options, async () => {
  const h = await operatorLifecycleFixture();
  try {const first = await h.create(), second = await h.create({summary: "Новое описание той же проблемы", signalId: "second_signal"});
    assert.equal(first.id, second.id); assert.equal(h.store.records.size, 2);
    assert.equal([...h.store.records.values()].every(row => row.payload.signalId === "initial_signal"), true);
  } finally {await h.close();}
});
test("transient recovery preserves a genuine complaint and its delivery plan", options, async () => {
  const h = await operatorLifecycleFixture();
  try {const first = await h.create(), second = await h.create({kind: "unresolved", source: "ai_unavailable", summary: "TEXT_MODEL_TIMEOUT"});
    assert.equal(second.id, first.id); assert.equal(second.kind, "complaint"); assert.equal(second.preservedExistingCase, true);
    assert.equal(h.store.records.size, 2);
  } finally {await h.close();}
});

import test from "node:test";
import assert from "node:assert/strict";
import { envNumber } from "../src/utils/envNumber.js";

// Live defect, 2026-08-11: OPENBOT_RESPONSE_CHUNK_MAX held a 62-character
// non-numeric value in the deployment env. Number() gave NaN, Math.max(180, NaN)
// is NaN, and every "length <= NaN" test is false - so the WhatsApp chunker
// stopped honouring its limit and a one-link answer still arrived as two
// messages. A bad value must fall back, not poison the arithmetic.
test("a non-numeric env value falls back to the default instead of becoming NaN", () => {
  assert.equal(envNumber("hDhxkqZvocnJd11PYurYkmfzJnbtkzr0Ywpt7iNjyzOk", 320, { min: 180 }), 320);
  assert.equal(envNumber("", 320, { min: 180 }), 320);
  assert.equal(envNumber(undefined, 320, { min: 180 }), 320);
  assert.equal(envNumber("   ", 320, { min: 180 }), 320);
});

test("a real value is honoured, and the bounds still clamp it", () => {
  assert.equal(envNumber("500", 320, { min: 180 }), 500);
  assert.equal(envNumber("10", 320, { min: 180 }), 180);
  assert.equal(envNumber("999999", 320, { min: 180, max: 1000 }), 1000);
  assert.equal(envNumber("0", 60, { min: 10 }), 10);
});

test("no setting can come out NaN or Infinity", () => {
  for (const raw of ["NaN", "Infinity", "-Infinity", "1e", "abc", "12abc", "{}"]) {
    const value = envNumber(raw, 42, { min: 1, max: 100 });
    assert.ok(Number.isFinite(value), raw);
  }
});

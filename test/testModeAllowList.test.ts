import { test } from "node:test";
import assert from "node:assert/strict";
import { testModeAllowedPhones } from "../src/services/inboundGuard.service.js";

// Test mode admitted exactly one number, so the owner testing from their own
// handset was dropped as `test_mode_blocked` — indistinguishable from a dead bot.
test("the tenant dev phone is still allowed", () => {
  const allowed = testModeAllowedPhones({ dev_phone: "+7 701 000 0001" }, {});
  assert.equal(allowed.has("77010000001"), true);
  assert.equal(allowed.size, 1);
});

test("a deployment allow-list and a tenant test_phones list both widen it", () => {
  const allowed = testModeAllowedPhones(
    { dev_phone: "77010000001", test_phones: "77769156184, 77021112233" },
    { TEST_MODE_ALLOWED_PHONES: "+7 705 444 5566" }
  );
  assert.deepEqual(
    [...allowed].sort(),
    ["77010000001", "77021112233", "77054445566", "77769156184"]
  );
});

test("garbage entries never become an allowed phone", () => {
  const allowed = testModeAllowedPhones({ dev_phone: "", test_phones: "abc, 123" }, { TEST_MODE_ALLOWED_PHONES: " , " });
  assert.equal(allowed.size, 0);
});

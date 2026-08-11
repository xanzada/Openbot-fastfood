import { test } from "node:test";
import assert from "node:assert/strict";
import { callAlemiCommand } from "../src/services/alemiApi.service.js";

// The platform's multi-tenant index blanks Alemi secrets. Whenever that redacted
// record was the one cached, every hub call died with ALEMI_SECRET_NOT_CONFIGURED
// and the guest was told there was no data. One authoritative re-read fixes it.
test("a secret-less config is re-read once instead of failing the hub call", async () => {
  let refreshCalls = 0;
  let signedInstance = "";
  const result: any = await callAlemiCommand("prestige", "runtime.status.get", {}, {
    config: { instance_id: "prestige", alemi_instance: "prestige" },
    env: { ALEMI_API_URL: "https://hub.example.test" },
    refreshConfig: async (instanceId: string) => {
      refreshCalls += 1;
      return { instance_id: instanceId, alemi_instance: instanceId, alemi_secret: "s3cret" };
    },
    transport: async ({ headers }: any) => {
      signedInstance = String(headers["X-Platform-Instance"] || "");
      return { statusCode: 200, body: JSON.stringify({ ok: true, data: { accepting_orders: true } }) };
    },
  } as any);

  assert.equal(refreshCalls, 1, "expected exactly one authoritative config re-read");
  assert.equal(signedInstance, "prestige");
  assert.notEqual(result, null);
});

test("a config that can already sign is not re-read", async () => {
  let refreshCalls = 0;
  await callAlemiCommand("prestige", "runtime.status.get", {}, {
    config: { instance_id: "prestige", alemi_instance: "prestige", alemi_secret: "s3cret" },
    env: { ALEMI_API_URL: "https://hub.example.test" },
    refreshConfig: async () => { refreshCalls += 1; return null; },
    transport: async () => ({ statusCode: 200, body: JSON.stringify({ ok: true, data: {} }) }),
  } as any);
  assert.equal(refreshCalls, 0);
});

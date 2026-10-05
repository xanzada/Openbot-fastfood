import test from "node:test";
import assert from "node:assert/strict";
import { sendAndRemember } from "../src/controllers/kanban.js";

test("a skipped gateway send cannot remember a site notice as sent", async () => {
  let remembered = 0;
  await assert.rejects(sendAndRemember("audit-resto", "70000000001", "Order notice", {
    send: async () => ({ skipped: true, reason: "tenant transport not configured" }),
    remember: async () => { remembered++; return true; },
    requestScope: "event-1",
  }), /WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED/);
  assert.equal(remembered, 0);
});

test("a queued gateway response cannot masquerade as delivered", async () => {
  let remembered = 0;
  await assert.rejects(sendAndRemember("audit-resto", "70000000001", "Order notice", {
    send: async () => ({ ok: true, acknowledged: true, queued: true }),
    remember: async () => { remembered++; return true; },
    requestScope: "event-2",
  }), /WHATSPRO_DELIVERY_NOT_ACKNOWLEDGED/);
  assert.equal(remembered, 0);
});

test("retry after history failure keeps the same outbound id", async () => {
  const ids: unknown[] = [];
  let remembers = 0;
  const dependencies = {
    send: async (payload: any) => { ids.push(payload.requestId); return { acknowledged: true, ok: true }; },
    remember: async () => { if (++remembers === 1) throw new Error("history unavailable"); return true; },
    requestScope: "same-site-event",
  };
  await assert.rejects(sendAndRemember("audit-resto", "70000000001", "Order notice", dependencies), /history unavailable/);
  await sendAndRemember("audit-resto", "70000000001", "Order notice", dependencies);
  assert.match(String(ids[0]), /^[a-f0-9]{64}$/);
  assert.equal(ids[0], ids[1]);
});

test("distinct site events have distinct stable outbound ids", async () => {
  const ids: unknown[] = [];
  const send = async (payload: any) => { ids.push(payload.requestId); return { acknowledged: true, ok: true }; };
  const remember = async () => true;
  for (const requestScope of ["event-A", "event-B"]) {
    await sendAndRemember("audit-resto", "70000000001", "Same text", { send, remember, requestScope });
  }
  assert.notEqual(ids[0], ids[1]);
});

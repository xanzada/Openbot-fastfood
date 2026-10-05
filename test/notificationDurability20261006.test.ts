import test from "node:test";
import assert from "node:assert/strict";
import { queueOperatorCaseNotifications } from "../src/services/operatorNotification.service.js";
import { queueDurableNotification, type NotificationRecord, type NotificationStore } from "../src/services/durableNotification.service.js";

function occupiedStore(record: NotificationRecord | null = null): NotificationStore {
  return { get: async () => record, claim: async () => false, release: async () => {},
    save: async () => { throw new Error("unexpected write"); }, due: async () => [] };
}
test("occupied orphan prepare leases cannot report successful SOS planning", async () => {
  const store = occupiedStore();
  await assert.rejects(queueOperatorCaseNotifications({ instanceId: "fixture", phone: "00000000000", caseId: "case_fixture", signalId: "signal", kind: "complaint", summary: "fixture" }, 1000, store), /NOTIFICATION_PREPARE_BUSY/);
});
test("occupied delivery lease may reuse an already persisted plan", async () => {
  const record: NotificationRecord = { instance_id: "fixture", status: "pending", prepared_at: new Date(1000).toISOString(), attempts: 0, next_attempt_at: 1000, recipient: "", text: "", payload: {} };
  const saved = await queueDurableNotification({ key: "fixture-key", index: "fixture-index", instanceId: "fixture", payload: {}, store: occupiedStore(record) });
  assert.equal(saved, record);
});

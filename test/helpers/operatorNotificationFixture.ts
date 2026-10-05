import {queueOperatorCaseNotifications, drainOperatorNotifications} from "../../src/services/operatorNotification.service.js";
import type {NotificationRecord, NotificationStore} from "../../src/services/durableNotification.service.js";
export class FixtureNotificationStore implements NotificationStore {
  records = new Map<string, NotificationRecord>(); locks = new Map<string, string>();
  indexes = new Map<string, Map<string, number>>();
  async get(key: string) {return this.records.has(key) ? structuredClone(this.records.get(key)!) : null;}
  async save(key: string, index: string, record: NotificationRecord) {
    this.records.set(key, structuredClone(record));
    const items = this.indexes.get(index) || new Map(); this.indexes.set(index, items);
    if (record.status === "delivered") items.delete(key); else items.set(key, record.next_attempt_at);
  }
  async claim(key: string, token: string) {if (this.locks.has(key)) return false; this.locks.set(key, token); return true;}
  async release(key: string, token: string) {if (this.locks.get(key) === token) this.locks.delete(key);}
  async due(index: string, now: number) {return [...(this.indexes.get(index) || new Map()).entries()].filter(([, at]) => at <= now).map(([key]) => key);}
}
export function operatorFixture() {
  const store = new FixtureNotificationStore(); const hub: any[] = []; const sends: any[] = []; const events: any[] = [];
  const input = {instanceId: "fixture", phone: "70000000002", caseId: "case_fixture", signalId: "signal_fixture",
    kind: "complaint", summary: "Cold delivery", source: "ai_tool_escalate_to_admin"};
  const legacy = new Set<string>();
  const deps: any = {store,
    loadConfig: async () => ({instance_id: "fixture", admin_phone: "70000000001"}),
    send: async (payload: any) => {sends.push(payload); return {acknowledged: true};},
    sendHub: async (payload: any) => {hub.push(payload); return {ok: true};},
    legacyHubSent: async (args: any) => legacy.has(args.caseId),
    markLegacyHubSent: async (args: any) => {legacy.add(args.caseId);},
    log: (event: string, row: NotificationRecord) => {events.push({event, row: structuredClone(row)});},
  };
  return {store, hub, sends, events, deps, input, legacy,
    queue: () => queueOperatorCaseNotifications(input, 1000, store),
    run: (now = 1000) => drainOperatorNotifications([{instance_id: "fixture"}], now, deps)};
}


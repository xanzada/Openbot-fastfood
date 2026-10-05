import crypto from "node:crypto";
import { redisClient } from "./redis.service.js";

const TTL_SECONDS = 45 * 24 * 60 * 60;
export interface NotificationRecord {
  instance_id: string; status: "pending" | "delivered";
  prepared_at: string; first_attempt_at?: string; attempts: number;
  next_attempt_at: number; last_error?: string; delivered_at?: string;
  recipient: string; text: string; payload: Record<string, any>; report_date?: string;
}
export interface NotificationStore {
  get(key: string): Promise<NotificationRecord | null>;
  save(key: string, index: string, record: NotificationRecord, token?: string): Promise<void>;
  prepare?(key: string, index: string, record: NotificationRecord): Promise<NotificationRecord>;
  renew?(key: string, token: string): Promise<void>;
  quarantine?(index: string, key: string, now?: number): Promise<void>;
  claim(key: string, token: string): Promise<boolean>;
  release(key: string, token: string): Promise<void>;
  due(index: string, now: number, limit?: number): Promise<string[]>;
}
export const redisNotificationStore: NotificationStore = {
  async get(key) {
    if (!redisClient.isOpen) throw new Error("REDIS_UNAVAILABLE");
    const value = await redisClient.get(key);
    return value ? JSON.parse(value) : null;
  },
  async prepare(key, index, record) {
    if (!redisClient.isOpen) throw new Error("REDIS_UNAVAILABLE");
    const value = await redisClient.eval(
      "local existing=redis.call('GET',KEYS[1]); if existing then local r=cjson.decode(existing); if r.instance_id~=ARGV[3] then return redis.error_reply('NOTIFICATION_SCOPE_MISMATCH') end; if r.status=='pending' then redis.call('PERSIST',KEYS[1]); redis.call('PERSIST',KEYS[2]); redis.call('ZADD',KEYS[2],r.next_attempt_at,KEYS[1]); end; return existing end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('ZADD',KEYS[2],ARGV[2],KEYS[1]); redis.call('PERSIST',KEYS[2]); return ARGV[1]",
      { keys: [key, index], arguments: [JSON.stringify(record), String(record.next_attempt_at), record.instance_id] });
    return JSON.parse(String(value)) as NotificationRecord;
  },
  async save(key, index, record, token) {
    if (!redisClient.isOpen) throw new Error("REDIS_UNAVAILABLE");
    const result = await redisClient.eval(
      "if ARGV[4]~='' and redis.call('GET',KEYS[3])~=ARGV[4] then return 0 end; if ARGV[3]=='delivered' then redis.call('SET',KEYS[1],ARGV[1],'EX',ARGV[5]); redis.call('ZREM',KEYS[2],KEYS[1]); else redis.call('SET',KEYS[1],ARGV[1]); redis.call('ZADD',KEYS[2],ARGV[2],KEYS[1]); redis.call('PERSIST',KEYS[2]); end; return 1",
      { keys: [key, index, key + ":lock"], arguments: [JSON.stringify(record), String(record.next_attempt_at), record.status, token || "", String(TTL_SECONDS)] });
    if (Number(result) !== 1) throw new Error("NOTIFICATION_LEASE_LOST");
  },
  async claim(key, token) {
    if (!redisClient.isOpen) throw new Error("REDIS_UNAVAILABLE");
    return await redisClient.set(key + ":lock", token, {NX: true, EX: 120}) === "OK";
  },
  async renew(key, token) {
    const result = await redisClient.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('EXPIRE',KEYS[1],120) else return 0 end",
      {keys: [key + ":lock"], arguments: [token]});
    if (Number(result) !== 1) throw new Error("NOTIFICATION_LEASE_LOST");
  },
  async release(key, token) {
    await redisClient.eval("if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      {keys: [key + ":lock"], arguments: [token]});
  },
  async due(index, now, limit = 20) {
    if (!redisClient.isOpen) throw new Error("REDIS_UNAVAILABLE");
    const keys = await redisClient.zRangeByScore(index, 0, now, {LIMIT: {offset: 0, count: limit}});
    const valid: string[] = [];
    for (const key of keys) {
      // A failed Redis read is a storage failure, never a quarantine decision.
      const raw = await redisClient.get(key);
      try {
        const record: NotificationRecord | null = raw ? JSON.parse(raw) : null;
        if (!record || !["pending", "delivered"].includes(record.status) || !Number.isFinite(record.next_attempt_at)) throw new Error("NOTIFICATION_RECORD_INVALID");
        if (record.status === "delivered") { await redisClient.zRem(index, key); continue; }
        valid.push(key);
      } catch (error) {
        // Only payload parse/shape errors are record-corruption evidence.
        if (!(error instanceof SyntaxError) && (error as Error)?.message !== "NOTIFICATION_RECORD_INVALID") throw error;
        await this.quarantine!(index, key, now);
      }
    }
    return valid;
  },
  async quarantine(index, key, now = Date.now()) {
    await redisClient.eval("redis.call('ZADD',KEYS[2],ARGV[1],ARGV[2]); redis.call('ZREM',KEYS[1],ARGV[2]); return 1",
      {keys: [index, index + ":quarantine"], arguments: [String(now), key]});
    console.error("[NOTIFICATION] record quarantined id=" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 16));
  },
};
export function safeNotificationError(error: any) {
  const status = Number(error?.response?.status || error?.statusCode);
  if (status >= 100 && status <= 599) {
    const hubCode = String(error?.response?.data?.error?.code || error?.response?.data?.code || "");
    return `HTTP_${status}` + (/^[A-Z][A-Z0-9_]{1,60}$/.test(hubCode) ? `:${hubCode}` : "");
  }
  const code = String(error?.code || error?.message || "");
  return /^[A-Z][A-Z0-9_]{1,80}$/.test(code) ? code : "NOTIFICATION_FAILED";
}
export function normalizeNotificationPhone(value: unknown) {
  const raw = String(value || "").trim();
  // Display masks must NEVER become routing identities.
  if (!/^\+?[\d\s()-]+$/.test(raw)) return "";
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 ? digits : "";
}
export function guardedAdminRecipient(config: Record<string, any>, customerPhones: unknown[] = [], analytics = false) {
  const raw = analytics ? config.analytics_phone || config.owner_phone || config.admin_phone : config.admin_phone;
  const recipient = normalizeNotificationPhone(raw);
  if (!recipient) throw new Error("ADMIN_RECIPIENT_MISSING");
  // The explicit configured admin/owner may use the connected WhatsApp account
  // itself. Transport self-send is valid; only customer identity is forbidden.
  // Developer fields never participate in destination selection above.
  const forbidden = [...customerPhones]
    .map(normalizeNotificationPhone).filter(Boolean);
  if (forbidden.includes(recipient)) throw new Error("ADMIN_RECIPIENT_COLLISION");
  return recipient;
}
export async function queueDurableNotification(input: {
  key: string; index: string; instanceId: string; payload: Record<string, any>;
  recipient?: string; text?: string; now?: number; store?: NotificationStore;
}) {
  const store = input.store || redisNotificationStore;
  const now = input.now ?? Date.now();
  const record: NotificationRecord = {
    instance_id: input.instanceId, status: "pending", prepared_at: new Date(now).toISOString(),
    attempts: 0, next_attempt_at: now, recipient: input.recipient || "", text: input.text || "",
    payload: input.payload, report_date: input.payload.report_date,
  };
  if (store.prepare) {
    const saved = await store.prepare(input.key, input.index, record);
    if (saved.instance_id !== input.instanceId) throw new Error("NOTIFICATION_SCOPE_MISMATCH");
    return saved;
  }
  const token = crypto.randomUUID();
  if (!await store.claim(input.key, token)) {
    const existing = await store.get(input.key);
    if (!existing) throw new Error("NOTIFICATION_PREPARE_BUSY");
    if (existing.instance_id !== input.instanceId) throw new Error("NOTIFICATION_SCOPE_MISMATCH");
    return existing;
  }
  try {
    const existing = await store.get(input.key);
    if (existing) {
      if (existing.instance_id !== input.instanceId) throw new Error("NOTIFICATION_SCOPE_MISMATCH");
      return existing;
    }
    await store.save(input.key, input.index, record, token);
    return record;
  } finally { await store.release(input.key, token); }
}
/** Durable prepare -> attempt -> transport acceptance. All network effects require an acquired Redis lease. */
export async function deliverDurableNotification(input: {
  key: string; index: string; instanceId: string; now?: number; store?: NotificationStore; initialPayload?: Record<string, any>;
  prepare: (record: NotificationRecord | null) => Promise<{recipient: string; text: string; payload: Record<string, any>}>;
  validate?: (record: NotificationRecord) => Promise<void>;
  send: (record: NotificationRecord, requestId: string) => Promise<boolean>;
  retryDelaysMs?: number[];
  log?: (event: string, record: NotificationRecord) => void;
}) {
  const store = input.store || redisNotificationStore;
  const now = input.now ?? Date.now();
  const existing = await store.get(input.key);
  if (existing && existing.instance_id !== input.instanceId) throw new Error("NOTIFICATION_SCOPE_MISMATCH");
  if (existing?.status === "delivered") return existing;
  if (existing && existing.next_attempt_at > now) return existing;
  const token = crypto.randomUUID();
  if (!await store.claim(input.key, token)) return null;
  const heartbeat = store.renew ? setInterval(() => {
    void store.renew!(input.key, token).catch(() => console.error("[NOTIFICATION] lease renewal failed"));
  }, 30_000) : null;
  heartbeat?.unref?.();
  let record: NotificationRecord | null = null;
  const log = input.log || (() => {});
  try {
    record = await store.get(input.key);
    if (record && record.instance_id !== input.instanceId) throw new Error("NOTIFICATION_SCOPE_MISMATCH");
    if (record?.status === "delivered" || (record && record.next_attempt_at > now)) return record;
    record ||= {instance_id: input.instanceId, status: "pending", prepared_at: new Date(now).toISOString(),
      attempts: 0, next_attempt_at: now, recipient: "", text: "", payload: input.initialPayload || {}, report_date: input.initialPayload?.report_date};
    if (!record.text) {
      const prepared = await input.prepare(record);
      record = {...record, ...prepared, report_date: prepared.payload.report_date};
      await store.save(input.key, input.index, record, token);
      log("prepared", record);
    }
    await input.validate?.(record);
    record.attempts++;
    record.first_attempt_at ||= new Date(now).toISOString();
    const retries = input.retryDelaysMs || [120_000, 240_000, 600_000, 900_000];
    record.next_attempt_at = now + retries[Math.min(record.attempts - 1, retries.length - 1)];
    // Persist the in-flight attempt first. A crash retries the exact payload/request ID.
    await store.save(input.key, input.index, record, token);
    log("send_attempt", record);
    const requestId = crypto.createHash("sha256").update(input.key).digest("hex");
    if (!await input.send(record, requestId)) throw new Error("TRANSPORT_NOT_ACKNOWLEDGED");
    record.status = "delivered"; record.delivered_at = new Date(now).toISOString();
    record.last_error = "";
    await store.save(input.key, input.index, record, token);
    log("delivered", record);
    return record;
  } catch (error) {
    if (!record || record.instance_id !== input.instanceId) throw error;
    record.last_error = safeNotificationError(error);
    if (record.next_attempt_at <= now) record.next_attempt_at = now + 60_000;
    await store.save(input.key, input.index, record, token);
    log("retry_scheduled", record);
    return record;
  } finally { if (heartbeat) clearInterval(heartbeat); await store.release(input.key, token); }
}


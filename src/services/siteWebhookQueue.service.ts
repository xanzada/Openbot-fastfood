import crypto from "node:crypto";
import { connectRedis, redisClient } from "./redis.service.js";
import { auditDecision, auditError } from "./auditLogger.service.js";
import { isValidOrderId } from "../controllers/kanban.js";

export interface SiteWebhookJob {
  id: string;
  body: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}
export interface SiteWebhookStore {
  put(job: SiteWebhookJob): Promise<boolean>;
  due(now: number, limit: number): Promise<SiteWebhookJob[]>;
  claim(job: SiteWebhookJob, token: string): Promise<boolean>;
  renew(job: SiteWebhookJob, token: string): Promise<void>;
  finish(job: SiteWebhookJob, token: string): Promise<void>;
  retry(job: SiteWebhookJob, token: string): Promise<void>;
}
export type SiteWebhookProcessor = (body: Record<string, unknown>) => Promise<{ status: number; retryLater?: boolean }>;
const ORDER_ACTIONS = new Set(["new_order", "request_payment", "status_changed", "payment_timing_changed", "order_rejected"]);
const DUE_KEY = "site_webhook:due";
const QUARANTINE_KEY = "site_webhook:quarantine";
const jobKey = (job: SiteWebhookJob) => `site_webhook:job:${job.id}`;
const laneKey = (job: SiteWebhookJob) => `site_webhook:lane:${crypto.createHash("sha256").update(JSON.stringify([job.body.instance, job.body.order_id])).digest("hex")}`;
const LEASE_MS = 20_000;

export function isQueuedSiteOrderAction(body: Record<string, unknown>) {
  return ORDER_ACTIONS.has(String(body.action || ""));
}
export function siteWebhookRetryDelay(attempts: number) {
  if (attempts <= 3) return [2_000, 5_000, 10_000][Math.max(0, attempts - 1)]!;
  return Math.min(300_000, 10_000 * 2 ** Math.min(attempts - 3, 5));
}

export const redisSiteWebhookStore: SiteWebhookStore = {
  async put(job) {
    await connectRedis();
    const result = await redisClient.eval(
      "if redis.call('EXISTS',KEYS[1])==1 then return 0 end; redis.call('SET',KEYS[1],ARGV[1]); redis.call('ZADD',KEYS[2],ARGV[2],ARGV[3]); return 1",
      { keys: [jobKey(job), DUE_KEY], arguments: [JSON.stringify(job), String(job.nextAttemptAt), job.id] },
    );
    return Number(result) === 1;
  },
  async due(now, limit) {
    await connectRedis();
    const ids = await redisClient.sendCommand(["ZRANGEBYSCORE", DUE_KEY, "-inf", String(now), "LIMIT", "0", String(limit)]) as string[];
    const jobs: SiteWebhookJob[] = [];
    for (const id of ids) {
      const raw = await redisClient.get(`site_webhook:job:${id}`);
      try {
        if (!raw) throw new Error("SITE_WEBHOOK_RECORD_MISSING");
        const job = JSON.parse(raw) as SiteWebhookJob;
        if (job.id !== id || !job.body?.instance || !Number.isFinite(job.nextAttemptAt)) throw new Error("SITE_WEBHOOK_RECORD_INVALID");
        jobs.push(job);
      } catch {
        // Preserve any original payload for inspection; isolate only the due index.
        await redisClient.eval("redis.call('ZADD',KEYS[2],ARGV[1],ARGV[2]); redis.call('ZREM',KEYS[1],ARGV[2]); return 1", {
          keys: [DUE_KEY, QUARANTINE_KEY], arguments: [String(now), id],
        });
        auditError("SITE_WEBHOOK record quarantined", new Error("SITE_WEBHOOK_RECORD_INVALID"), { jobId: id });
      }
    }
    return jobs;
  },
  async claim(job, token) {
    return await redisClient.set(laneKey(job), token, { NX: true, PX: LEASE_MS }) === "OK";
  },
  async renew(job, token) {
    const result = await redisClient.eval("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end; return 0", {
      keys: [laneKey(job)], arguments: [token, String(LEASE_MS)],
    });
    if (Number(result) !== 1) throw new Error("SITE_WEBHOOK_LEASE_LOST");
  },
  async finish(job, token) {
    const result = await redisClient.eval(
      "if redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',604800); redis.call('ZREM',KEYS[2],ARGV[3]); redis.call('DEL',KEYS[3]); return 1",
      { keys: [jobKey(job), DUE_KEY, laneKey(job)], arguments: [token, JSON.stringify({ id: job.id, createdAt: job.createdAt, attempts: job.attempts, status: "processed" }), job.id] },
    );
    if (Number(result) !== 1) throw new Error("SITE_WEBHOOK_LEASE_LOST");
  },
  async retry(job, token) {
    const result = await redisClient.eval(
      "if redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4]); redis.call('DEL',KEYS[3]); return 1",
      { keys: [jobKey(job), DUE_KEY, laneKey(job)], arguments: [token, JSON.stringify(job), String(job.nextAttemptAt), job.id] },
    );
    if (Number(result) !== 1) throw new Error("SITE_WEBHOOK_LEASE_LOST");
  },
};

function sanitizeDurablePayload(value: unknown, depth = 0): unknown {
  if (depth > 30) throw new Error("BAD_SITE_ORDER_EVENT");
  if (Array.isArray(value)) return value.map(item => sanitizeDurablePayload(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (["__proto__", "constructor", "prototype"].includes(key)) continue;
      if (/secret|password|passwd|authorization|credential|token|api[_-]?key/i.test(key)) continue;
      result[key] = sanitizeDurablePayload((value as Record<string, unknown>)[key], depth + 1);
    }
    return result;
  }
  return value;
}

export function createSiteWebhookQueue(options: {
  store: SiteWebhookStore;
  process: SiteWebhookProcessor;
  now?: () => number;
}) {
  const now = options.now || Date.now;
  let draining = false;
  async function enqueue(body: Record<string, unknown>) {
    const instance = String(body.instance || "");
    const orderId = String(body.order_id || body.orderId || body.id || "");
    if (!/^[a-zA-Z0-9_-]{2,64}$/.test(instance)) throw new Error("BAD_INSTANCE");
    if (!isQueuedSiteOrderAction(body) || !isValidOrderId(orderId) || orderId === "0") throw new Error("BAD_SITE_ORDER_EVENT");
    // Route authentication is complete; credentials are unnecessary to workers.
    // Sorting also makes retry identity independent of JSON field order.
    const persistedBody = sanitizeDurablePayload({ ...body, order_id: orderId }) as Record<string, unknown>;
    const id = crypto.createHash("sha256").update(JSON.stringify([
      instance, String(body.action), orderId, body.event_id || body.request_id || persistedBody,
    ])).digest("hex");
    const timestamp = now();
    const inserted = await options.store.put({ id, body: persistedBody, createdAt: timestamp, attempts: 0, nextAttemptAt: timestamp });
    return { id, inserted };
  }
  async function drain() {
    if (draining) return { checked: 0, processed: 0 };
    draining = true;
    let processed = 0;
    try {
      const jobs = await options.store.due(now(), 24);
      // Distinct orders may proceed together; each order holds a cross-process lease.
      for (let start = 0; start < jobs.length; start += 4) {
        const results = await Promise.allSettled(jobs.slice(start, start + 4).map(async (job) => {
          const token = crypto.randomUUID();
          if (!await options.store.claim(job, token)) return;
          const heartbeat = setInterval(() => {
            void options.store.renew(job, token).catch(() => auditError("SITE_WEBHOOK lease renewal failed", new Error("SITE_WEBHOOK_LEASE_LOST"), { jobId: job.id }));
          }, LEASE_MS / 4);
          heartbeat.unref?.();
          try {
            const result = await options.process({ ...job.body });
            if (result.status < 200 || result.status >= 300 || result.retryLater) throw new Error("SITE_WEBHOOK_PROCESSING_PENDING");
            await options.store.finish(job, token);
            processed++;
            auditDecision("SITE_WEBHOOK processed", { instance: job.body.instance, jobId: job.id, attempts: job.attempts });
          } catch (error) {
            const attempts = job.attempts + 1;
            await options.store.retry({ ...job, attempts, nextAttemptAt: now() + siteWebhookRetryDelay(attempts) }, token);
            auditError("SITE_WEBHOOK retry scheduled", new Error("SITE_WEBHOOK_PROCESSING_PENDING"), { instance: job.body.instance, jobId: job.id, attempts });
          } finally {
            clearInterval(heartbeat);
          }
        }));
        for (const result of results) {
          if (result.status === "rejected") auditError("SITE_WEBHOOK persistence failed", new Error("SITE_WEBHOOK_STORAGE_UNAVAILABLE"), { scope: "site_webhook_worker" });
        }
      }
      return { checked: jobs.length, processed };
    } finally {
      draining = false;
    }
  }
  return { enqueue, drain };
}

let processor: SiteWebhookProcessor | null = null;
const queue = createSiteWebhookQueue({
  store: redisSiteWebhookStore,
  process: (body) => {
    if (!processor) throw new Error("SITE_WEBHOOK_WORKER_NOT_STARTED");
    return processor(body);
  },
});
let worker: ReturnType<typeof setInterval> | null = null;
function triggerDrain() {
  void queue.drain().catch((error) => auditError("SITE_WEBHOOK worker failed", error, { scope: "site_webhook_worker" }));
}
export async function enqueueVerifiedSiteWebhook(body: Record<string, unknown>) {
  const result = await queue.enqueue(body);
  setImmediate(triggerDrain);
  return result;
}
export function startSiteWebhookQueueWorker(process: SiteWebhookProcessor) {
  processor = process;
  if (!worker) {
    worker = setInterval(triggerDrain, 1_000);
    worker.unref?.();
    setImmediate(triggerDrain);
  }
  return worker;
}

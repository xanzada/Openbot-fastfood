import crypto from "node:crypto";
import { connectRedis, redisClient } from "./redis.service.js";
import { MAX_INBOUND_WEBHOOK_BYTES } from "../utils/mediaLimits.js";

export interface InboundWebhookIdentity { instance: string; phone: string; messageId: string; text: string; hasMedia: boolean; bufferMs: number }
export interface InboundWebhookJob {
  id: string; instance: string; phone: string; body: Record<string, unknown>; text: string; kind: "text" | "media";
  createdAt: number; nextAttemptAt: number; attempts: number; bytes: number; textChars: number; sequence?: number;
  members?: string[]; fragments?: string[]; rootId?: string;
}
export interface InboundWebhookStore {
  put(job: InboundWebhookJob): Promise<boolean>;
  due(now: number, limit: number): Promise<InboundWebhookJob[]>;
  claim(job: InboundWebhookJob, token: string, now: number): Promise<InboundWebhookJob | null>;
  renew(job: InboundWebhookJob, token: string): Promise<void>;
  finish(job: InboundWebhookJob, token: string): Promise<void>;
  retry(job: InboundWebhookJob, token: string, at: number): Promise<void>;
}
export type InboundWebhookProcessor = (body: Record<string, unknown>, started: number, durable: { fragments: string[]; attempts: number }) => Promise<void>;
const LEASE_MS = 20_000;
const DONE_SECONDS = 86_400;
const MAX_BYTES = MAX_INBOUND_WEBHOOK_BYTES;
// Retain aggregate backpressure while allowing two maximal media envelopes.
const MAX_QUEUE_BYTES = Math.max(128 * 1024 * 1024, 2 * MAX_BYTES);
const MAX_QUEUE_JOBS = 1024;
const MAX_LANE_JOBS = 64;
const ID_RE = /^[a-f0-9]{64}$/;
const ALLOWED_FIELDS = new Set((
  "instance instanceId instance_id restaurant_id restaurant_instance restaurantInstance normalizedPhone senderPhone phone sender from chatId " +
  "body text message caption data messageData key id messageId remoteJid participant fromMe isFromMe isGroup source " +
  "type mediaKind hasMedia media imageMessage documentMessage audioMessage videoMessage stickerMessage ptvMessage ephemeralMessage " +
  "conversation extendedTextMessage contact contactName contactShortName contactPushName pushName pushname name shortName isMyContact addressBookKnown " +
  "mediaId mimetype mimeType mediaType fileLength fileSize size sizeBytes mediaSize duration seconds ptt isPtt isVoiceNote " +
  "mediaUrl downloadUrl url base64 dataUrl mediaData timestamp messageTimestamp"
).split(/\s+/));

function sanitizeBody(value: unknown, depth = 0, budget = { nodes: 0 }): unknown {
  if (++budget.nodes > 4096 || depth > 16) throw new Error("BAD_INBOUND_EVENT");
  if (Array.isArray(value)) throw new Error("BAD_INBOUND_EVENT");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || !value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("BAD_INBOUND_EVENT");
  const keys = Object.keys(value); if (keys.length > 128) throw new Error("BAD_INBOUND_EVENT");
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys.sort()) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("BAD_INBOUND_EVENT");
    if (!ALLOWED_FIELDS.has(key) || /secret|password|passwd|authorization|credential|cookie|token|api[_-]?key/i.test(key)) continue;
    const field = (value as Record<string, unknown>)[key];
    if (field === undefined) continue;
    // Downloads use fresh tenant credentials; bearer/userinfo URLs are not queued.
    if (/^(?:url|mediaUrl|downloadUrl)$/.test(key) && typeof field === "string" && /^https?:/i.test(field)) {
      let url: URL; try { url = new URL(field); } catch { throw new Error("BAD_INBOUND_EVENT"); }
      if (url.username || url.password || [...url.searchParams.keys()].some(k => /token|secret|password|credential|api[_-]?key/i.test(k))) throw new Error("BAD_INBOUND_EVENT");
    }
    result[key] = sanitizeBody(field, depth + 1, budget);
  }
  return result;
}

export function createInboundWebhookJob(body: unknown, identity: InboundWebhookIdentity, now = Date.now()): InboundWebhookJob {
  if (!/^[a-zA-Z0-9_-]{2,64}$/.test(identity.instance) || !/^(?:\d{10,15}|\d+@lid)$/.test(identity.phone)
    || typeof identity.messageId !== "string" || identity.messageId.length > 160 || typeof identity.text !== "string"
    || !Number.isFinite(now) || !Number.isFinite(identity.bufferMs)) throw new Error("BAD_INBOUND_EVENT");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("BAD_INBOUND_EVENT");
  const persisted = sanitizeBody(body) as Record<string, unknown>;
  persisted.instance = identity.instance; persisted.normalizedPhone = identity.phone;
  const discriminator = identity.messageId || JSON.stringify(persisted);
  const id = crypto.createHash("sha256").update(JSON.stringify([identity.instance, identity.phone, discriminator])).digest("hex");
  // An id-less accepted job also has a stable processing/request scope on restart.
  persisted.messageId = identity.messageId || `queued:${id}`;
  const job: InboundWebhookJob = { id, instance: identity.instance, phone: identity.phone, body: persisted, text: identity.text,
    kind: identity.hasMedia ? "media" : "text", createdAt: now, attempts: 0, bytes: 0, textChars: identity.text.length,
    nextAttemptAt: now + (identity.hasMedia ? 0 : Math.max(0, Math.min(5000, identity.bufferMs))) };
  // Count both the original body and extracted text, with room for the frozen
  // eight-member bundle and JSON escaping. The limit bounds serialized payloads,
  // rather than pretending to measure Redis allocator overhead.
  job.bytes = Buffer.byteLength(JSON.stringify(job), "utf8") + 32_768;
  if (job.bytes > MAX_BYTES) throw new Error("INBOUND_EVENT_TOO_LARGE");
  return job;
}

export function inboundWebhookRetryDelay(attempts: number) {
  // The original guard's anti_dup expires after five seconds. Do not complete a
  // failed turn by replaying it as duplicate_text inside that window.
  return Math.min(300_000, 10_000 * 2 ** Math.min(Math.max(0, attempts - 1), 5));
}
function validJob(job: any): job is InboundWebhookJob {
  return !!job && ID_RE.test(job.id) && /^[a-zA-Z0-9_-]{2,64}$/.test(job.instance) && /^(?:\d{10,15}|\d+@lid)$/.test(job.phone)
    && !!job.body && typeof job.body === "object" && !Array.isArray(job.body) && typeof job.text === "string"
    && ["text", "media"].includes(job.kind) && Number.isSafeInteger(job.sequence) && job.sequence > 0
    && Number.isFinite(job.createdAt) && Number.isFinite(job.nextAttemptAt) && Number.isSafeInteger(job.attempts) && job.attempts >= 0
    && Number.isSafeInteger(job.bytes) && job.bytes >= 0 && job.bytes <= MAX_BYTES && job.textChars === job.text.length
    && (!job.rootId || ID_RE.test(job.rootId))
    && (!job.members || (Array.isArray(job.members) && job.members.length >= 1 && job.members.length <= 8 && new Set(job.members).size === job.members.length && job.members[0] === job.id && job.members.every((id: unknown) => typeof id === "string" && ID_RE.test(id))))
    && (!job.fragments || (Array.isArray(job.fragments) && job.fragments.length <= 8 && job.fragments.every((s: unknown) => typeof s === "string")));
}

export function createRedisInboundWebhookStore(client: typeof redisClient = redisClient, ensure: () => Promise<void> = connectRedis, prefix = "inbound_webhook"): InboundWebhookStore {
  if (!/^[a-zA-Z0-9_:-]+$/.test(prefix)) throw new Error("BAD_INBOUND_NAMESPACE");
  // The installed node-redis supports a command deadline. A stalled Redis must
  // reject acceptance and leave recovery work pending, without wedging a drain.
  client = client.withCommandOptions({ timeout: 2500 }) as typeof redisClient;
  const dueKey = `${prefix}:due`, bytesKey = `${prefix}:bytes`, countKey = `${prefix}:count`, sequenceKey = `${prefix}:sequence`;
  const key = (id: string) => `${prefix}:job:${id}`;
  const lane = (job: Pick<InboundWebhookJob, "instance" | "phone">) => `${prefix}:lane:${crypto.createHash("sha256").update(JSON.stringify([job.instance, job.phone])).digest("hex")}`;
  const evalScript = async (script: string, keys: string[], args: string[]) => { await ensure(); return client.eval(script, { keys, arguments: args }); };
  const owned = "if redis.call('GET',KEYS[3])~=ARGV[1] then return 0 end; ";
  return {
    async put(job) {
      const result = await evalScript(`
        local expected={'string','zset','zset','string','string','string'}
        for i,k in ipairs(KEYS) do local t=redis.call('TYPE',k).ok; if t~='none' and t~=expected[i] then return redis.error_reply('INBOUND_STORAGE_TYPE') end end
        local raw=redis.call('GET',KEYS[1]); if raw then
          local old=cjson.decode(raw); if old.status=='processed' then return 0 end
          redis.call('ZADD',KEYS[3],old.sequence,old.id)
          local head=redis.call('ZRANGE',KEYS[3],0,0); if head[1]==old.id and not old.rootId then redis.call('ZADD',KEYS[2],old.nextAttemptAt,old.id) end; return 0
        end
        if tonumber(redis.call('GET',KEYS[4]) or '0')+tonumber(ARGV[2])>tonumber(ARGV[4]) or tonumber(redis.call('GET',KEYS[5]) or '0')>=tonumber(ARGV[5]) or redis.call('ZCARD',KEYS[3])>=tonumber(ARGV[6]) then return redis.error_reply('INBOUND_QUEUE_CAPACITY') end
        local j=cjson.decode(ARGV[1]); j.sequence=redis.call('INCR',KEYS[6]);
        redis.call('INCRBY',KEYS[4],ARGV[2]); redis.call('INCR',KEYS[5]);
        redis.call('SET',KEYS[1],cjson.encode(j)); redis.call('ZADD',KEYS[3],j.sequence,j.id)
        local head=redis.call('ZRANGE',KEYS[3],0,0); if head[1]==j.id then redis.call('ZADD',KEYS[2],j.nextAttemptAt,j.id) end; return 1
      `, [key(job.id), dueKey, lane(job), bytesKey, countKey, sequenceKey], [JSON.stringify(job), String(job.bytes), job.id, String(MAX_QUEUE_BYTES), String(MAX_QUEUE_JOBS), String(MAX_LANE_JOBS)]);
      return Number(result) === 1;
    },
    async due(now, limit) {
      await ensure(); const ids = await client.sendCommand(["ZRANGEBYSCORE", dueKey, "-inf", String(now), "LIMIT", "0", String(limit)]) as string[];
      const jobs: InboundWebhookJob[] = [];
      for (const id of ids) {
        const raw = ID_RE.test(id) ? await client.get(key(id)) : null;
        let value: any; try { value = raw ? JSON.parse(raw) : null; } catch {}
        if (value?.status === "processed") { await client.zRem(dueKey, id); continue; }
        if (!validJob(value) || value.id !== id || value.rootId) {
          // Payload remains available privately; never retry a malformed record.
          await client.multi().zAdd(`${prefix}:quarantine`, [{ score: now, value: id }]).zRem(dueKey, id).exec();
          if (typeof value?.instance === "string" && typeof value?.phone === "string") {
            const laneKey = lane(value); await client.zRem(laneKey, id);
            const head = (await client.zRange(laneKey, 0, 0))[0]; if (head) {
              const nextRaw = await client.get(key(head)); let next: any; try { next = JSON.parse(nextRaw || "null"); } catch {}
              if (validJob(next) && !next.rootId) await client.zAdd(dueKey, [{score: next.nextAttemptAt, value: head}]);
            }
          }
          console.error("[OPENBOT:INBOUND_QUEUE] event=QUARANTINED job=" + crypto.createHash("sha256").update(id).digest("hex").slice(0, 16));
          continue;
        }
        jobs.push(value);
      }
      return jobs;
    },
    async claim(job, token, now) {
      const result = await evalScript(`
        if redis.call('EXISTS',KEYS[3])==1 then return nil end
        local head=redis.call('ZRANGE',KEYS[2],0,0); if head[1]~=ARGV[1] then return nil end
        local raw=redis.call('GET',KEYS[1]); if not raw then return nil end; local j=cjson.decode(raw)
        if j.status or j.rootId or j.nextAttemptAt>tonumber(ARGV[3]) then return nil end
        if not j.members then
          j.members={j.id}; j.fragments={j.text}; local updates={}; local chars=j.textChars
          if j.kind=='text' then
            local ids=redis.call('ZRANGE',KEYS[2],1,7)
            for _,id in ipairs(ids) do
              local r=redis.call('GET',ARGV[5]..id); if not r then break end; local child=cjson.decode(r)
              if child.kind~='text' or child.rootId or child.members or child.nextAttemptAt>tonumber(ARGV[3]) or child.instance~=j.instance or child.phone~=j.phone or chars+child.textChars>2000 then break end
              chars=chars+child.textChars; child.rootId=j.id; table.insert(j.members,id); table.insert(j.fragments,child.text); table.insert(updates,ARGV[5]..id); table.insert(updates,cjson.encode(child))
            end
          end
          table.insert(updates,KEYS[1]); table.insert(updates,cjson.encode(j)); redis.call('MSET',unpack(updates))
          for i=2,#j.members do redis.call('ZREM',KEYS[4],j.members[i]) end
        end
        redis.call('SET',KEYS[3],ARGV[2],'PX',ARGV[4]); return cjson.encode(j)
      `, [key(job.id), lane(job), lane(job) + ":lease", dueKey], [job.id, token, String(now), String(LEASE_MS), `${prefix}:job:`]);
      if (!result) return null; const claimed = JSON.parse(String(result)); if (!validJob(claimed)) throw new Error("INBOUND_RECORD_INVALID"); return claimed;
    },
    async renew(job, token) {
      const result = await evalScript("if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) end; return 0", [lane(job) + ":lease"], [token, String(LEASE_MS)]);
      if (Number(result) !== 1) throw new Error("INBOUND_LEASE_LOST");
    },
    async finish(job, token) {
      const result = await evalScript(owned + `
        local j=cjson.decode(redis.call('GET',KEYS[1])); local total=0
        for _,id in ipairs(j.members) do local raw=redis.call('GET',ARGV[3]..id); if not raw then return redis.error_reply('INBOUND_MEMBER_MISSING') end; local child=cjson.decode(raw); if id~=j.id and child.rootId~=j.id then return redis.error_reply('INBOUND_MEMBER_CONFLICT') end; total=total+child.bytes end
        for _,id in ipairs(j.members) do redis.call('SET',ARGV[3]..id,cjson.encode({id=id,status='processed',createdAt=j.createdAt,attempts=j.attempts}),'EX',ARGV[2]); redis.call('ZREM',KEYS[2],id); redis.call('ZREM',KEYS[4],id) end
        redis.call('DECRBY',KEYS[5],total); redis.call('DECRBY',KEYS[6],#j.members)
        local nextIds=redis.call('ZRANGE',KEYS[4],0,0); if nextIds[1] then local raw=redis.call('GET',ARGV[3]..nextIds[1]); if raw then local next=cjson.decode(raw); redis.call('ZADD',KEYS[2],next.nextAttemptAt,next.id) end end
        redis.call('DEL',KEYS[3]); return 1
      `, [key(job.id), dueKey, lane(job) + ":lease", lane(job), bytesKey, countKey], [token, String(DONE_SECONDS), `${prefix}:job:`]);
      if (Number(result) !== 1) throw new Error("INBOUND_LEASE_LOST");
    },
    async retry(job, token, at) {
      const result = await evalScript(owned + "local j=cjson.decode(redis.call('GET',KEYS[1])); j.attempts=j.attempts+1; j.nextAttemptAt=tonumber(ARGV[2]); redis.call('SET',KEYS[1],cjson.encode(j)); redis.call('ZADD',KEYS[2],ARGV[2],j.id); redis.call('DEL',KEYS[3]); return 1", [key(job.id), dueKey, lane(job) + ":lease"], [token, String(at)]);
      if (Number(result) !== 1) throw new Error("INBOUND_LEASE_LOST");
    },
  };
}

export function createInboundWebhookQueue(options: { store: InboundWebhookStore; process: InboundWebhookProcessor; now?: () => number }) {
  const now = options.now || Date.now; let draining = false;
  async function enqueue(body: unknown, identity: InboundWebhookIdentity) {
    const job = createInboundWebhookJob(body, identity, now()); const inserted = await options.store.put(job); return { id: job.id, inserted };
  }
  async function drain() {
    if (draining) return { checked: 0, processed: 0 }; draining = true; let processed = 0;
    try {
      const jobs = await options.store.due(now(), 32);
      for (let start = 0; start < jobs.length; start += 4) {
        const results = await Promise.allSettled(jobs.slice(start, start + 4).map(async candidate => {
          const token = crypto.randomUUID(); const job = await options.store.claim(candidate, token, now()); if (!job) return;
          let leaseLost = false; let renewing: Promise<void> | null = null;
          const heartbeat = setInterval(() => { if (!renewing) renewing = options.store.renew(job, token).catch(() => { leaseLost = true; }).finally(() => { renewing = null; }); }, LEASE_MS / 4); heartbeat.unref?.();
          try {
            await options.process({ ...job.body }, job.createdAt, { fragments: job.fragments || [job.text], attempts: job.attempts });
            if (renewing) await renewing; if (leaseLost) throw new Error("INBOUND_LEASE_LOST");
            await options.store.finish(job, token); processed++;
          } catch {
            await options.store.retry(job, token, now() + inboundWebhookRetryDelay(job.attempts + 1));
            console.warn("[OPENBOT:INBOUND_QUEUE] event=RETRY job=" + job.id.slice(0, 16));
          } finally { clearInterval(heartbeat); }
        }));
        for (const result of results) if (result.status === "rejected") console.error("[OPENBOT:INBOUND_QUEUE] event=STORAGE_OR_LEASE_PENDING");
      }
      return { checked: jobs.length, processed };
    } finally { draining = false; }
  }
  return { enqueue, drain };
}
let processor: InboundWebhookProcessor | null = null;
const queue = createInboundWebhookQueue({ store: createRedisInboundWebhookStore(), process: (...args) => {
  if (!processor) throw new Error("INBOUND_WORKER_NOT_STARTED"); return processor(...args);
} });
let worker: ReturnType<typeof setInterval> | null = null;
function triggerDrain() { void queue.drain().catch(() => console.error("[OPENBOT:INBOUND_QUEUE] event=STORAGE_PENDING")); }
export async function enqueueVerifiedInboundWebhook(body: unknown, identity: InboundWebhookIdentity) { const result = await queue.enqueue(body, identity); setImmediate(triggerDrain); return result; }
export function startInboundWebhookQueueWorker(process: InboundWebhookProcessor) {
  processor = process; if (!worker) { worker = setInterval(triggerDrain, 1000); worker.unref?.(); setImmediate(triggerDrain); } return worker;
}

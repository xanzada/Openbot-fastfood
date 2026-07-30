import { connectRedis, redisClient } from "./redis.service.js";
/**
 * Lightweight operational metrics.
 *
 * Counters per tenant per day: how many turns, how many escalations, how often
 * the validator had to edit, how often the think layer fired, how often the
 * critic rewrote a reply, and reply latency buckets. This is what lets us see
 * whether the agent is actually getting smarter instead of just feeling
 * smarter. One Redis hash increment per event - negligible cost, no new infra.
 */
const METRICS_TTL_SECONDS = 60 * 60 * 24 * 45;
function dayKey(date = new Date()) {
    return date.toISOString().slice(0, 10).replace(/-/g, "");
}
export function metricsKey(instanceId, day = dayKey()) {
    return `metrics:${instanceId}:${day}`;
}
export async function bumpMetric(instanceId, name, amount = 1) {
    try {
        if (!instanceId || !Number.isFinite(amount) || amount === 0)
            return;
        await connectRedis();
        const key = metricsKey(instanceId);
        await redisClient.multi()
            .hIncrBy(key, name, Math.trunc(amount))
            .expire(key, METRICS_TTL_SECONDS)
            .exec();
    }
    catch {
        // Metrics must never break the reply path.
    }
}
export async function recordLatency(instanceId, elapsedMs) {
    const bucket = elapsedMs < 4_000 ? "latency_fast" : elapsedMs < 10_000 ? "latency_medium" : "latency_slow";
    await bumpMetric(instanceId, bucket);
}
export async function snapshotMetrics(instanceId, days = 7) {
    const result = {};
    try {
        await connectRedis();
        for (let i = 0; i < days; i += 1) {
            const date = new Date(Date.now() - i * 86_400_000);
            const key = metricsKey(instanceId, dayKey(date));
            const raw = await redisClient.hGetAll(key).catch(() => ({}));
            if (raw && Object.keys(raw).length) {
                result[dayKey(date)] = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v) || 0]));
            }
        }
    }
    catch {
        // Return whatever was collected.
    }
    return result;
}

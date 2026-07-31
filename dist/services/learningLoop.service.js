import { connectRedis, redisClient } from "./redis.service.js";
const EVENTS_KEY_PREFIX = "learning:events:";
const EVENTS_TTL_SECONDS = 60 * 60 * 24 * 30;
const EVENTS_MAX = 200;
export function learningEventsKey(instanceId) {
    return `${EVENTS_KEY_PREFIX}${instanceId}`;
}
export async function recordLearningEvent(instanceId, event) {
    try {
        if (!instanceId)
            return;
        await connectRedis();
        const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
        await redisClient.multi()
            .lPush(learningEventsKey(instanceId), payload)
            .lTrim(learningEventsKey(instanceId), 0, EVENTS_MAX - 1)
            .expire(learningEventsKey(instanceId), EVENTS_TTL_SECONDS)
            .exec();
    }
    catch {
        // Learning is observability; it must never break the reply path.
    }
}
export async function readLearningEvents(instanceId, limit = EVENTS_MAX) {
    try {
        await connectRedis();
        const raw = await redisClient.lRange(learningEventsKey(instanceId), 0, Math.max(0, limit - 1));
        return raw
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((event) => Boolean(event));
    }
    catch {
        return [];
    }
}

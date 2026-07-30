import { connectRedis, redisClient } from "./redis.service.js";

/**
 * The self-learning loop's memory.
 *
 * Every turn where something went less than perfectly - the validator had to
 * cut a claim, the critic demanded a rewrite, a conversation ended in an
 * escalation - leaves a small structured event here. An offline script
 * (scripts/learnFromFailures.ts) reads these events, clusters them, and turns
 * the repeating failures into candidate test scenarios, so next week's smoke
 * suite contains this week's real mistakes. Nothing here touches the customer
 * path: one capped Redis list write, fire-and-forget.
 */

export interface LearningEvent {
  type: "validator_edit" | "critic_regen" | "escalation" | "fallback_reply";
  detail: string;
  phone?: string;
  at: string;
}

const EVENTS_KEY_PREFIX = "learning:events:";
const EVENTS_TTL_SECONDS = 60 * 60 * 24 * 30;
const EVENTS_MAX = 200;

export function learningEventsKey(instanceId: string) {
  return `${EVENTS_KEY_PREFIX}${instanceId}`;
}

export async function recordLearningEvent(instanceId: string, event: Omit<LearningEvent, "at">): Promise<void> {
  try {
    if (!instanceId) return;
    await connectRedis();
    const payload = JSON.stringify({ ...event, at: new Date().toISOString() });
    await redisClient.multi()
      .lPush(learningEventsKey(instanceId), payload)
      .lTrim(learningEventsKey(instanceId), 0, EVENTS_MAX - 1)
      .expire(learningEventsKey(instanceId), EVENTS_TTL_SECONDS)
      .exec();
  } catch {
    // Learning is observability; it must never break the reply path.
  }
}

export async function readLearningEvents(instanceId: string, limit = EVENTS_MAX): Promise<LearningEvent[]> {
  try {
    await connectRedis();
    const raw = await redisClient.lRange(learningEventsKey(instanceId), 0, Math.max(0, limit - 1));
    return raw
      .map((line) => {
        try {
          return JSON.parse(line) as LearningEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is LearningEvent => Boolean(event));
  } catch {
    return [];
  }
}

/**
 * Offline self-learning loop.
 *
 * Reads the learning events the live pipeline recorded (validator edits,
 * critic regenerations, escalations, fallback replies), clusters them by
 * repeating detail, and emits:
 *  - learning-report.json: counts and top recurring failure patterns
 *  - learning-scenarios.md: candidate smoke scenarios derived from the most
 *    frequent real failures, ready to be reviewed and added to the smoke suite
 *
 * This never edits prompts or code by itself: it produces the evidence and the
 * draft scenarios; a human (or an instructed agent) decides what becomes a
 * permanent regression test. Run: npm run learn
 */
import { readLearningEvents, type LearningEvent } from "../src/services/learningLoop.service.js";
import { snapshotMetrics } from "../src/services/metrics.service.js";
import { writeFileSync } from "node:fs";

const instanceId = String(process.env.LEARN_INSTANCE_ID || process.argv[2] || "").trim();
if (!instanceId) {
  console.error("usage: tsx scripts/learnFromFailures.ts <instanceId>");
  process.exit(1);
}

function cluster(events: LearningEvent[]) {
  const counts = new Map<string, { type: string; count: number; examples: string[] }>();
  for (const event of events) {
    const key = `${event.type}:${event.detail || "-"}`;
    const entry = counts.get(key) || { type: event.type, count: 0, examples: [] };
    entry.count += 1;
    if (entry.examples.length < 2 && event.detail) entry.examples.push(event.detail);
    counts.set(key, entry);
  }
  return [...counts.entries()]
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => b.count - a.count);
}

function scenarioDrafts(clusters: ReturnType<typeof cluster>) {
  return clusters.slice(0, 10).map((entry, index) => {
    const hint =
      entry.type === "validator_edit"
        ? "Verify the agent never emits this class of ungrounded claim; the reply must stay helpful without it."
        : entry.type === "critic_regen"
          ? "Replay a high-risk turn that previously needed a critic rewrite; the first draft must now pass the critic."
          : entry.type === "escalation"
            ? "Confirm this escalation class is still routed with a complete operator digest and a calm customer reply."
            : "Confirm the model never falls back to the generic line in this situation.";
    return `## Candidate scenario ${index + 1}: ${entry.key}\n- seen: ${entry.count}x\n- examples: ${entry.examples.join(" | ") || "-"}\n- test intent: ${hint}\n`;
  });
}

const [events, metrics] = await Promise.all([
  readLearningEvents(instanceId, 200),
  snapshotMetrics(instanceId, 7),
]);

const clusters = cluster(events);
const report = {
  instance: instanceId,
  generated_at: new Date().toISOString(),
  total_events: events.length,
  by_type: clusters.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.type] = (acc[entry.type] || 0) + entry.count;
    return acc;
  }, {}),
  top_patterns: clusters.slice(0, 15),
  metrics_last_7_days: metrics,
};

writeFileSync("learning-report.json", JSON.stringify(report, null, 2));
writeFileSync(
  "learning-scenarios.md",
  [`# Learning scenarios for ${instanceId}`, `Generated: ${report.generated_at}`, "", ...scenarioDrafts(clusters)].join("\n")
);

console.log(`[LEARN] events=${events.length} patterns=${clusters.length}`);
console.log(`[LEARN] wrote learning-report.json and learning-scenarios.md`);

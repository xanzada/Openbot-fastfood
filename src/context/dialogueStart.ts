const OUTBOUND_DIALOGUE_ROLES = new Set(["assistant", "model", "bot", "operator"]);
export const DIALOGUE_IDLE_MS = 8 * 60 * 60_000;

function outboundTime(entry: Record<string, unknown>): number | null {
  const value = entry.createdAt ?? entry.timestamp;
  const time = typeof value === "number" ? value
    : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : null;
}

/** Only a known last outbound can declare an idle reset; the current inbound may already be stored. */
export function dialogueStartFromHistory(history: unknown, now = Date.now()): boolean {
  if (!Array.isArray(history)) return true;
  const outbound = history.filter((entry): entry is Record<string, unknown> =>
    Boolean(entry && typeof entry === "object"
      && OUTBOUND_DIALOGUE_ROLES.has(String(entry.role || "").trim().toLowerCase()))
  );
  if (!outbound.length) return true;
  const times = outbound.map(outboundTime);
  if (!Number.isFinite(now) || times.some(time => time === null || time > now)) return false;
  return now - Math.max(...times as number[]) >= DIALOGUE_IDLE_MS;
}

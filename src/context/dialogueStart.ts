const OUTBOUND_DIALOGUE_ROLES = new Set(["assistant", "model", "bot", "operator"]);

export function dialogueStartFromHistory(history: unknown): boolean {
  if (!Array.isArray(history)) return true;
  return !history.some((entry: any) =>
    OUTBOUND_DIALOGUE_ROLES.has(String(entry?.role || "").trim().toLowerCase())
  );
}

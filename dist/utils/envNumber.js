/**
 * A numeric setting read from the environment.
 *
 * Live defect, 2026-08-11: `OPENBOT_RESPONSE_CHUNK_MAX` held a 62-character
 * non-numeric value (a mis-pasted token in the deployment env). `Number()`
 * returned NaN, `Math.max(180, NaN)` is NaN, and every `length <= NaN`
 * comparison is false - so the WhatsApp chunker silently stopped honouring its
 * own limit and a one-link answer kept arriving as two messages no matter what
 * the code said. A bad value must fall back to the default, not poison the
 * arithmetic, and the same read is repeated across ~27 settings.
 */
export function envNumber(value, fallback, bounds = {}) {
    const parsed = Number(String(value ?? "").trim());
    let result = Number.isFinite(parsed) && String(value ?? "").trim() !== "" ? parsed : fallback;
    if (typeof bounds.min === "number")
        result = Math.max(bounds.min, result);
    if (typeof bounds.max === "number")
        result = Math.min(bounds.max, result);
    return result;
}

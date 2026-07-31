import { getOpenRouterProvider, getTextModels } from "./llm.service.js";
/**
 * The buffer's brain.
 *
 * WhatsApp guests rarely send one message: they send three. The old buffer
 * glued the parts with a space, which is exactly how "магаан пицца" + "бар ма" + "алыңыз"
 * became a confused blob the agent then misread. This service merges the parts
 * into ONE coherent message before the agent ever sees it - preserving every
 * fact, every number, every name, and the customer's language.
 *
 * Cost discipline: short or single-part batches skip the model entirely, and
 * any failure falls back to the deterministic join. The merged text is only
 * used for understanding; the original parts stay in history untouched.
 */
const TRIVIAL_PART_RE = /^(сәлем|салем|рақмет|рахмет|жақсы|жарайды|болды|ок|okay|ok|иә|ия|жоқ|қош|привет|спасибо|хорошо|ладно|понял|да|нет|пока|\+|-|👍|🙏|🙂)[\s!.🙂👍🙏]*$/iu;
/**
 * Deterministic merge used for trivial batches and as the fallback. Keeps the
 * parts verbatim; just joins them so no fact can be lost.
 */
export function mergePartsDeterministic(parts) {
    return parts.map((part) => String(part || "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}
/** A batch only earns the model merge when gluing would actually lose meaning. */
export function needsSmartMerge(parts) {
    const clean = parts.map((part) => String(part || "").trim()).filter(Boolean);
    if (clean.length < 2)
        return false;
    const joined = mergePartsDeterministic(clean);
    if (joined.length < 45)
        return false;
    if (clean.every((part) => TRIVIAL_PART_RE.test(part)))
        return false;
    return true;
}
function brainModel() {
    const modelId = String(process.env.THINK_MODEL || "").trim() || getTextModels().reserve;
    return getOpenRouterProvider().chat(modelId);
}
const MERGE_SYSTEM_PROMPT = `You merge fragmented WhatsApp messages from ONE customer into one clean message.
Rules:
- Preserve every fact, number, name, dish, address, and question exactly - never invent or drop information.
- Keep the customer's language (Kazakh stays Kazakh, Russian stays Russian, mixed stays mixed).
- Fix only obvious split-word cuts and ordering; keep the casual tone.
- Output ONLY the merged message text, nothing else.`;
/**
 * Merges buffered parts into one coherent customer message. One cheap call,
 * hard 4-second cap; any failure returns the deterministic join.
 */
export async function mergeBufferedParts(parts, language = "ru") {
    const clean = parts.map((part) => String(part || "").trim()).filter(Boolean).slice(0, 8);
    const fallback = mergePartsDeterministic(clean);
    if (!needsSmartMerge(clean))
        return fallback;
    try {
        const { generateText } = await import("ai");
        const timeoutMs = Math.max(2_500, Math.min(8_000, Number(process.env.BUFFER_BRAIN_TIMEOUT_MS || 4_000)));
        const result = await Promise.race([
            generateText({
                model: brainModel(),
                temperature: 0,
                system: MERGE_SYSTEM_PROMPT,
                prompt: `customer_language_hint: ${language}\nparts:\n${clean.map((part, index) => `${index + 1}) ${part.slice(0, 400)}`).join("\n")}`,
            }),
            new Promise((_resolve, reject) => setTimeout(() => reject(new Error("BUFFER_BRAIN_TIMEOUT")), timeoutMs)),
        ]);
        const merged = String(result?.text || "").replace(/\s+/g, " ").trim().slice(0, 2000);
        // Never let the merge shrink away information: if the model dropped half
        // the content, the deterministic join is the safer truth.
        if (!merged || merged.length < fallback.length * 0.5)
            return fallback;
        console.info(`[BUFFER:BRAIN] merged parts=${clean.length} chars=${fallback.length}->${merged.length}`);
        return merged;
    }
    catch (error) {
        console.warn(`[BUFFER:BRAIN] fallback reason=${error?.message || error}`);
        return fallback;
    }
}

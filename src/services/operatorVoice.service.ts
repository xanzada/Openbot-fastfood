import { getOpenRouterProvider, getTextModels } from "./llm.service.js";
import { auditError } from "./auditLogger.service.js";

function voiceModel() {
  const modelId = String(process.env.THINK_MODEL || "").trim() || getTextModels().reserve;
  return getOpenRouterProvider().chat(modelId);
}

async function generateWithTimeout(model: any, args: Record<string, any>, timeoutMs: number) {
  const { generateText } = await import("ai");
  return await Promise.race([
    generateText({ model, temperature: 0, ...args } as any),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`VOICE_TIMEOUT:${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// The operator's raw cancel note reaches the guest only after a human-sounding
// rewrite: the bot speaks as the restaurant itself - never "оператор жазды",
// never a robotic quote with possible slang or typos. The AI internally knows
// the words came from the operator but never exposes that to the guest.
export async function humanizeCancellationReason(rawReason: string, lang: string): Promise<string> {
  const reason = String(rawReason || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!reason) return "";
  const target = lang === "ru" ? "Russian" : "Kazakh";
  try {
    const result: any = await generateWithTimeout(
      voiceModel(),
      {
        messages: [
          {
            role: "system",
            content: `You rewrite a restaurant's internal order-cancellation note into one short warm message for the guest, written in ${target}. Rules: speak as the restaurant itself; NEVER mention an operator, manager, admin, bot, AI, or system; keep the concrete reason (a dish is unavailable, payment not received, courier problem, guest unreachable); ALWAYS end with a short warm invitation to choose another dish from the menu (мәзір / меню); never promise vague future treats; max 230 characters; output ONLY the rewritten text, no quotes, no explanation.`,
          },
          { role: "user", content: reason },
        ],
      },
      8000
    );
    const text = String(result?.text || "")
      .replace(/\s+/g, " ")
      .replace(/^["'«»\s]+|["'«»\s]+$/g, "")
      .trim()
      .slice(0, 260);
    // If the model leaked the machinery words anyway, refuse and let the
    // caller fall back to the safe template.
    if (!text || /оператор|operator|админ|\bбот\b|жүйе|система|\bai\b/i.test(text)) return "";
    return text;
  } catch (error) {
    auditError("Cancellation humanize failed", error, { lang });
    return "";
  }
}

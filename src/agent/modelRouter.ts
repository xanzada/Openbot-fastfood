import { createOpenAI } from "@ai-sdk/openai";
import type { FastFoodContext } from "../context/types.js";

const openrouterProvider = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

function envText(name: string, fallback: string) {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function envTimeout(name: string, fallback: number) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) ? Math.max(5_000, Math.min(120_000, value)) : fallback;
}

async function timedModelCall(
  model: any,
  operation: "doGenerate" | "doStream",
  options: any,
  timeoutMs: number
) {
  const controller = new AbortController();
  const upstream = options?.abortSignal as AbortSignal | undefined;
  const forwardAbort = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) forwardAbort();
  else upstream?.addEventListener("abort", forwardAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`TEXT_MODEL_TIMEOUT:${model.modelId}:${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      model[operation].call(model, { ...options, abortSignal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    upstream?.removeEventListener("abort", forwardAbort);
  }
}

function createFallbackModel(primary: any, secondary: any, reserve: any): any {
  const wrapped = { ...primary };
  const primaryTimeout = envTimeout("TEXT_PRIMARY_TIMEOUT_MS", 15_000);
  const fallbackTimeout = envTimeout("TEXT_FALLBACK_TIMEOUT_MS", 15_000);
  const reserveTimeout = envTimeout("TEXT_RESERVE_TIMEOUT_MS", 40_000);

  if (typeof primary.doGenerate === "function") {
    wrapped.doGenerate = async (options: any) => {
      try {
        return await timedModelCall(primary, "doGenerate", options, primaryTimeout);
      } catch (primaryError: any) {
        console.warn(
          `[MODEL:TEXT] primary=${primary.modelId} failed; fallback=${secondary.modelId}; ` +
          `error=${primaryError?.message || primaryError}`
        );
        try {
          return await timedModelCall(secondary, "doGenerate", options, fallbackTimeout);
        } catch (fallbackError: any) {
          console.warn(
            `[MODEL:TEXT] fallback=${secondary.modelId} failed; reserve=${reserve.modelId}; ` +
            `error=${fallbackError?.message || fallbackError}`
          );
          return timedModelCall(reserve, "doGenerate", options, reserveTimeout);
        }
      }
    };
  }

  if (typeof primary.doStream === "function") {
    wrapped.doStream = async (options: any) => {
      try {
        return await timedModelCall(primary, "doStream", options, primaryTimeout);
      } catch (primaryError: any) {
        console.warn(
          `[MODEL:TEXT] primary_stream=${primary.modelId} failed; fallback=${secondary.modelId}; ` +
          `error=${primaryError?.message || primaryError}`
        );
        try {
          return await timedModelCall(secondary, "doStream", options, fallbackTimeout);
        } catch (fallbackError: any) {
          console.warn(
            `[MODEL:TEXT] fallback_stream=${secondary.modelId} failed; reserve=${reserve.modelId}; ` +
            `error=${fallbackError?.message || fallbackError}`
          );
          return timedModelCall(reserve, "doStream", options, reserveTimeout);
        }
      }
    };
  }

  return wrapped;
}

const textPrimaryModel = envText("TEXT_PRIMARY_MODEL", "deepseek/deepseek-chat");
const textFallbackModel = envText("TEXT_FALLBACK_MODEL", "deepseek/deepseek-chat-v3");
const textReserveModel = envText("TEXT_RESERVE_MODEL", "google/gemini-2.5-flash");

const textModel = createFallbackModel(
  // OpenRouter's broad model catalogue is chat-completions compatible. Calling
  // the provider as a function selects OpenAI's Responses API in AI SDK v6;
  // several OpenRouter models then accept the request but never finish.
  openrouterProvider.chat(textPrimaryModel),
  openrouterProvider.chat(textFallbackModel),
  openrouterProvider.chat(textReserveModel),
);

export function getTextModelId() {
  return {
    primary: textPrimaryModel,
    fallback: textFallbackModel,
    reserve: textReserveModel,
  };
}

export function resolveModel(_ctx: FastFoodContext) {
  return textModel;
}

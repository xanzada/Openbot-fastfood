import { createOpenAI } from "@ai-sdk/openai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { FastFoodContext } from "../context/types.js";

const openrouterProvider = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

const GEMINI_API_KEYS = (process.env.GEMINI_API_KEYS || "")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

function createFallbackModel(primary: any, secondary: any): any {
  const wrapped = { ...primary };

  if (typeof primary.doGenerate === "function") {
    const originalDoGenerate = primary.doGenerate.bind(primary);
    wrapped.doGenerate = async (options: any) => {
      try {
        return await originalDoGenerate(options);
      } catch (error: any) {
        console.warn(
          `[MODEL] Primary "${primary.modelId}" failed: ${error?.message}. Falling back to "${secondary.modelId}".`
        );
        return secondary.doGenerate.call(secondary, options);
      }
    };
  }

  if (typeof primary.doStream === "function") {
    const originalDoStream = primary.doStream.bind(primary);
    wrapped.doStream = async (options: any) => {
      try {
        return await originalDoStream(options);
      } catch (error: any) {
        console.warn(
          `[MODEL] Primary "${primary.modelId}" stream failed: ${error?.message}. Falling back to "${secondary.modelId}".`
        );
        return secondary.doStream.call(secondary, options);
      }
    };
  }

  return wrapped;
}

function createKeyRotationModel(
  keys: string[],
  modelId: string,
  finalFallback: any,
): any {
  if (keys.length === 0) return finalFallback;

  const provider = createGoogleGenerativeAI({ apiKey: keys[0] });
  const current = provider(modelId);
  const rest = createKeyRotationModel(keys.slice(1), modelId, finalFallback);
  return createFallbackModel(current, rest);
}

const textModel = createFallbackModel(
  openrouterProvider("deepseek/deepseek-chat"),
  openrouterProvider("google/gemini-2.5-flash"),
);

const multimodalModel = GEMINI_API_KEYS.length > 0
  ? createKeyRotationModel(
      GEMINI_API_KEYS,
      "gemini-2.5-flash",
      openrouterProvider("google/gemini-2.5-flash"),
    )
  : openrouterProvider("google/gemini-2.5-flash");

export function resolveModel(ctx: FastFoodContext) {
  const hasMedia = Boolean(
    ctx.mediaContext?.base64 && ctx.mediaContext?.valid,
  );
  return hasMedia ? multimodalModel : textModel;
}

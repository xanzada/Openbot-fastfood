import { createOpenAI } from "@ai-sdk/openai";
const openrouterProvider = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY
});
function envText(name, fallback) {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}
function createFallbackModel(primary, secondary) {
  const wrapped = { ...primary };
  if (typeof primary.doGenerate === "function") {
    const originalDoGenerate = primary.doGenerate.bind(primary);
    wrapped.doGenerate = async (options) => {
      try {
        return await originalDoGenerate(options);
      } catch (error) {
        console.warn(`[MODEL:TEXT] primary=${primary.modelId} failed; fallback=${secondary.modelId}; error=${error?.message || error}`);
        return secondary.doGenerate.call(secondary, options);
      }
    };
  }
  if (typeof primary.doStream === "function") {
    const originalDoStream = primary.doStream.bind(primary);
    wrapped.doStream = async (options) => {
      try {
        return await originalDoStream(options);
      } catch (error) {
        console.warn(`[MODEL:TEXT] primary_stream=${primary.modelId} failed; fallback=${secondary.modelId}; error=${error?.message || error}`);
        return secondary.doStream.call(secondary, options);
      }
    };
  }
  return wrapped;
}
const textPrimaryModel = envText("TEXT_PRIMARY_MODEL", "deepseek/deepseek-chat");
const textFallbackModel = envText("TEXT_FALLBACK_MODEL", "deepseek/deepseek-chat-v3");
const textModel = createFallbackModel(
  openrouterProvider(textPrimaryModel),
  openrouterProvider(textFallbackModel)
);
function getTextModelId() {
  return { primary: textPrimaryModel, fallback: textFallbackModel };
}
function resolveModel(_ctx) {
  return textModel;
}
export {
  getTextModelId,
  resolveModel
};

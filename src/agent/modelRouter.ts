import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import type { FastFoodContext } from "../context/types.js";
import { getTextModels } from "../services/llm.service.js";
import { getLlmWorkspacePools } from "../services/llmWorkspace.service.js";

const openrouterProvider = createOpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY,
});

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

// Failover was per-call with no memory: every step of a 6-step turn re-tried a dead
// primary (15s) then a dead fallback (15s) before reaching the reserve (40s), so one
// provider outage cost up to ~70s PER STEP - minutes of silence for the guest, while
// WhatsApp retries piled more turns onto the same failing provider
// (found 2026-08-22). A model that just failed is skipped for a short window.
const MODEL_FAILURE_COOLDOWN_MS = envTimeout("MODEL_FAILURE_COOLDOWN_MS", 60_000);
const modelFailedUntil = new Map<string, number>();

function modelIsCoolingDown(modelId: string) {
  const until = modelFailedUntil.get(modelId) || 0;
  if (until <= Date.now()) {
    if (until) modelFailedUntil.delete(modelId);
    return false;
  }
  return true;
}

function noteModelFailure(modelId: string) {
  modelFailedUntil.set(modelId, Date.now() + MODEL_FAILURE_COOLDOWN_MS);
}

function noteModelSuccess(modelId: string) {
  // A model that answers is healthy again immediately - never hold a working
  // provider out of rotation.
  modelFailedUntil.delete(modelId);
}

export function modelCooldownState() {
  const now = Date.now();
  return Object.fromEntries(
    [...modelFailedUntil.entries()].filter(([, until]) => until > now).map(([id, until]) => [id, until - now])
  );
}

export function clearModelCooldowns() {
  modelFailedUntil.clear();
}

/**
 * Runs the chain in order, skipping any model inside its failure window, and always
 * keeping the LAST model as a genuine last resort even if it is cooling down - a
 * turn must still produce an answer when every provider is unhappy.
 */
async function callChain(
  chain: { model: any; timeout: number; label: string }[],
  operation: "doGenerate" | "doStream",
  options: any
) {
  const usable = chain.filter((entry, index) => index === chain.length - 1 || !modelIsCoolingDown(entry.model.modelId));
  let lastError: any = new Error("MODEL_CHAIN_EMPTY");
  for (let index = 0; index < usable.length; index += 1) {
    const entry = usable[index];
    try {
      const result = await timedModelCall(entry.model, operation, options, entry.timeout);
      noteModelSuccess(entry.model.modelId);
      return result;
    } catch (error: any) {
      lastError = error;
      noteModelFailure(entry.model.modelId);
      const next = usable[index + 1];
      console.warn(
        `[MODEL:TEXT] ${entry.label}=${entry.model.modelId} failed; ` +
        `${next ? `next=${next.model.modelId}` : "no_more_models"}; ` +
        `error=${error?.message || error}`
      );
    }
  }
  throw lastError;
}

function createFallbackModel(primary: any, secondary: any, reserve: any): any {
  const primaryTimeout = envTimeout("TEXT_PRIMARY_TIMEOUT_MS", 15_000);
  const fallbackTimeout = envTimeout("TEXT_FALLBACK_TIMEOUT_MS", 15_000);
  const reserveTimeout = envTimeout("TEXT_RESERVE_TIMEOUT_MS", 40_000);

  return wrapChain([
    { model: primary, timeout: primaryTimeout, label: "primary" },
    { model: secondary, timeout: fallbackTimeout, label: "fallback" },
    { model: reserve, timeout: reserveTimeout, label: "reserve" },
  ]);
}

/** Wraps an ordered chain into one model object whose every call walks the chain. */
function wrapChain(chain: { model: any; timeout: number; label: string }[]): any {
  const wrapped = { ...chain[0].model };

  if (typeof chain[0].model.doGenerate === "function") {
    wrapped.doGenerate = (options: any) => callChain(chain, "doGenerate", options);
  }

  if (typeof chain[0].model.doStream === "function") {
    wrapped.doStream = (options: any) => callChain(chain, "doStream", options);
  }

  return wrapped;
}

// One source of truth for the chain. This file used to re-read the same env vars
// with its OWN defaults, so with the env unset the agent ran gemini-2.5-flash while
// the webhook logged deepseek-chat as "primary" and agentThinking / customerMemory
// picked yet another model as "reserve" - operators debugged against a model the
// agent never called (found 2026-08-22). llm.service.getTextModels owns it.
const { primary: textPrimaryModel, fallback: textFallbackModel, reserve: textReserveModel } = getTextModels();

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

// The panel's "Жұмыс кеңістігі" text pool, when the operator filled it. Entries
// must be OpenRouter-compatible (tool calls travel over chat-completions), so a
// gemini-typed entry is skipped with a note rather than silently breaking tools.
function workspaceTextChain(): { model: any; timeout: number; label: string }[] {
  const pools = getLlmWorkspacePools();
  const entries = (pools?.text || []).filter((entry) => entry.provider === "openrouter");
  if ((pools?.text || []).length !== entries.length) {
    console.warn("[MODEL:TEXT] workspace: gemini-typed text keys are not supported for tool-calling; skipped");
  }
  if (!entries.length) return [];

  const stepTimeout = envTimeout("TEXT_PRIMARY_TIMEOUT_MS", 15_000);
  const lastTimeout = envTimeout("TEXT_RESERVE_TIMEOUT_MS", 40_000);
  return entries.map((entry, index) => {
    const provider = createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: entry.key,
    });
    const keyFingerprint = createHash("sha1").update(entry.key).digest("hex").slice(0, 8);
    const model = provider.chat(entry.model) as any;
    model.modelId = `${entry.model}:${keyFingerprint}`;
    return { model, timeout: index === entries.length - 1 ? lastTimeout : stepTimeout, label: `workspace:${entry.name}` };
  });
}

const ENV_CHAIN = (() => {
  const primaryTimeout = envTimeout("TEXT_PRIMARY_TIMEOUT_MS", 15_000);
  const fallbackTimeout = envTimeout("TEXT_FALLBACK_TIMEOUT_MS", 15_000);
  const reserveTimeout = envTimeout("TEXT_RESERVE_TIMEOUT_MS", 40_000);
  return [
    { model: openrouterProvider.chat(textPrimaryModel), timeout: primaryTimeout, label: "primary" },
    { model: openrouterProvider.chat(textFallbackModel), timeout: fallbackTimeout, label: "fallback" },
    { model: openrouterProvider.chat(textReserveModel), timeout: reserveTimeout, label: "reserve" },
  ];
})();

export function resolveModel(_ctx: FastFoodContext) {
  // Workspace pool first, env chain always behind it as the last resort — so a
  // half-filled pool can never leave the bot with fewer options than before.
  const chain = [...workspaceTextChain(), ...ENV_CHAIN];
  if (chain.length === ENV_CHAIN.length) return textModel;
  return wrapChain(chain);
}

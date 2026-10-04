import { createHash } from "node:crypto";
import { createOpenAI } from "@ai-sdk/openai";
import type { FastFoodContext } from "../context/types.js";
import { getTextModels } from "../services/llm.service.js";
import { getLlmWorkspacePools } from "../services/llmWorkspace.service.js";
import type { LlmKeyEntry } from "../services/llmWorkspace.service.js";
import { noteProviderOutcome, providersForRequest } from "../services/llmProviderHealth.service.js";

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

// Only doGenerate returns `content`; a stream is judged by its consumer.
function ignoredPinnedTool(operation: string, options: any, result: any) {
  const pinned = options?.toolChoice?.type === "tool" || options?.toolChoice?.type === "required";
  return operation === "doGenerate" && pinned && !(result?.content || []).some((part: any) => part?.type === "tool-call");
}

// A 200 with nothing in it (finish_reason content_filter, a proxy's empty body) is a
// refusal, not an answer: the guest got the generic fallback while another lane was
// still untried (audit 2026-10-04).
function emptyCompletion(operation: string, result: any) {
  return operation === "doGenerate" && !(result?.content || []).some((part: any) =>
    part?.type === "tool-call" || (part?.type === "text" && String(part.text || "").trim()));
}

function hedgeDelayMs() {
  const value = Number(process.env.TEXT_HEDGE_DELAY_MS ?? 4_500);
  return Number.isFinite(value) ? Math.max(0, Math.min(60_000, value)) : 4_500;
}

function hedgeAttemptTimeoutMs() {
  return envTimeout("TEXT_HEDGE_ATTEMPT_TIMEOUT_MS", 15_000);
}

type ChainEntry = { model: any; timeout: number; label: string; providerEntry?: LlmKeyEntry };

function noteChainSuccess(entry: ChainEntry, result: any, startedAt: number) {
  noteModelSuccess(entry.label);
  if (!entry.providerEntry) return;
  const pTokens = Number(result?.usage?.promptTokens) || 0;
  const cTokens = Number(result?.usage?.completionTokens) || 0;
  const tTokens = Number(result?.usage?.totalTokens) || (pTokens + cTokens);
  noteProviderOutcome({
    entry: entry.providerEntry,
    pool: "text",
    ok: true,
    latencyMs: Date.now() - startedAt,
    promptTokens: pTokens,
    completionTokens: cTokens,
    totalTokens: tTokens,
  });
}

function isToolChoiceIgnoredError(error: any): boolean {
  return Boolean(error?.message && String(error.message).startsWith("TOOL_CHOICE_IGNORED"));
}

function noteChainFailure(entry: ChainEntry, error: any, startedAt: number) {
  if (isToolChoiceIgnoredError(error)) {
    // 200 OK with direct text is not a network or provider outage:
    // do not poison the model with 60s failure cooldown or mark provider suspect.
    return;
  }
  noteModelFailure(entry.label);
  if (entry.providerEntry) noteProviderOutcome({ entry: entry.providerEntry, pool: "text", ok: false, latencyMs: Date.now() - startedAt, error });
}

/**
 * Hedged chain (2026-10-04). The A6API lanes answer the same 20k-token prompt in
 * 5 s one minute and hang for 25-45 s the next. Run strictly one after another,
 * three such stalls (8 s + 8 s + 20 s) ended a live turn with "AI unavailable"
 * after 46 s while every provider was in fact up. Now the next lane is started
 * in PARALLEL as soon as the current one is slower than TEXT_HEDGE_DELAY_MS (or
 * fails), the first valid answer wins and the losers are aborted. A fast primary
 * costs exactly one call, as before. TEXT_HEDGE_DELAY_MS=0 restores the old
 * strictly sequential behaviour. Streams stay sequential.
 */
async function callChainHedged(chain: ChainEntry[], options: any) {
  const usable = chain.filter((entry, index) => index === chain.length - 1 || !modelIsCoolingDown(entry.label));
  const delay = hedgeDelayMs();
  const attemptTimeout = hedgeAttemptTimeoutMs();
  const upstream = options?.abortSignal as AbortSignal | undefined;
  return await new Promise<any>((resolve, reject) => {
    let launched = 0;
    let pending = 0;
    let settled = false;
    let lastError: any = new Error("MODEL_CHAIN_EMPTY");
    let lastTextFallback: { entry: ChainEntry; result: any; startedAt: number } | null = null;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
    const controllers: AbortController[] = [];
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (hedgeTimer) clearTimeout(hedgeTimer);
      for (const controller of controllers) {
        if (!controller.signal.aborted) controller.abort(new Error("HEDGE_LOSER_ABORTED"));
      }
      upstream?.removeEventListener("abort", onUpstreamAbort);
      fn();
    };
    const onUpstreamAbort = () => finish(() => reject(upstream?.reason || new Error("ABORTED")));
    if (upstream?.aborted) return onUpstreamAbort();
    upstream?.addEventListener("abort", onUpstreamAbort, { once: true });

    const scheduleHedge = () => {
      if (hedgeTimer) clearTimeout(hedgeTimer);
      if (delay > 0 && launched < usable.length) hedgeTimer = setTimeout(() => { launch("slow"); scheduleHedge(); }, delay);
    };
    const launch = (why: "first" | "slow" | "failed") => {
      if (settled || launched >= usable.length) return;
      const index = launched;
      launched += 1;
      pending += 1;
      const entry = usable[index];
      const isLast = index === usable.length - 1;
      const timeout = delay > 0 && !isLast ? Math.max(entry.timeout, attemptTimeout) : entry.timeout;
      const controller = new AbortController();
      controllers.push(controller);
      const startedAt = Date.now();
      if (why === "slow") console.warn(`[MODEL:TEXT] hedge: ${entry.label}=${entry.model.modelId} started in parallel (previous lane slower than ${delay}ms)`);
      timedModelCall(entry.model, "doGenerate", { ...options, abortSignal: controller.signal }, timeout)
        .then((result) => {
          pending -= 1;
          if (settled) return;
          // Accept an imperfect answer only when nothing else can still answer.
          const othersLeft = pending > 0 || launched < usable.length;
          if (othersLeft && ignoredPinnedTool("doGenerate", options, result)) {
            lastTextFallback = { entry, result, startedAt };
            throw new Error(`TOOL_CHOICE_IGNORED:${entry.model.modelId}`);
          }
          if (othersLeft && emptyCompletion("doGenerate", result)) throw new Error(`EMPTY_COMPLETION:${entry.model.modelId}`);
          noteChainSuccess(entry, result, startedAt);
          finish(() => resolve(result));
        }, (error) => {
          pending -= 1;
          throw error;
        })
        .catch((error: any) => {
          if (settled) return;
          lastError = error;
          noteChainFailure(entry, error, startedAt);
          const hasNext = launched < usable.length;
          console.warn(
            `[MODEL:TEXT] ${entry.label}=${entry.model.modelId} failed; ` +
            `${hasNext ? `next=${usable[launched].model.modelId}` : pending > 0 ? "waiting_parallel" : "no_more_models"}; ` +
            `error=${error?.message || error}`
          );
          if (hasNext) {
            launch("failed");
            scheduleHedge();
          } else if (pending === 0) {
            if (lastTextFallback) {
              const fallback = lastTextFallback;
              console.warn(`[MODEL:TEXT] all subsequent lanes failed; accepting fallback text result from ${fallback.entry.label}`);
              noteChainSuccess(fallback.entry, fallback.result, fallback.startedAt);
              finish(() => resolve(fallback.result));
            } else {
              finish(() => reject(lastError));
            }
          }
        });
    };
    launch("first");
    scheduleHedge();
  });
}

export async function callModelChain(
  chain: ChainEntry[],
  operation: "doGenerate" | "doStream",
  options: any
) {
  if (operation === "doGenerate" && hedgeDelayMs() > 0) return callChainHedged(chain, options);
  return callChainSequential(chain, operation, options);
}

/**
 * Runs the chain in order, skipping any model inside its failure window, and always
 * keeping the LAST model as a genuine last resort even if it is cooling down - a
 * turn must still produce an answer when every provider is unhappy.
 */
async function callChainSequential(

  chain: { model: any; timeout: number; label: string; providerEntry?: LlmKeyEntry }[],
  operation: "doGenerate" | "doStream",
  options: any
) {
  const usable = chain.filter((entry, index) => index === chain.length - 1 || !modelIsCoolingDown(entry.label));
  let lastError: any = new Error("MODEL_CHAIN_EMPTY");
  let lastTextFallback: { result: any; entry: any; startedAt: number } | null = null;
  for (let index = 0; index < usable.length; index += 1) {
    const entry = usable[index];
    const startedAt = Date.now();
    try {
      const result = await timedModelCall(entry.model, operation, options, entry.timeout);
      // A lane that drops `tools` still answers 200, just without the tool: the A6API
      // gemini-2.5-flash entry ignored a pinned searchMenu and quoted 1200 ₸ for a
      // 1590 ₸ doner (probe 2026-10-04). A pinned step with no tool call is a failed
      // lane while another lane is left to try.
      if (index < usable.length - 1 && ignoredPinnedTool(operation, options, result)) {
        lastTextFallback = { result, entry, startedAt };
        throw new Error(`TOOL_CHOICE_IGNORED:${entry.model.modelId}`);
      }
      if (index < usable.length - 1 && emptyCompletion(operation, result)) {
        throw new Error(`EMPTY_COMPLETION:${entry.model.modelId}`);
      }
      noteModelSuccess(entry.label);
      if (entry.providerEntry) {
        const pTokens = Number(result?.usage?.promptTokens) || 0;
        const cTokens = Number(result?.usage?.completionTokens) || 0;
        const tTokens = Number(result?.usage?.totalTokens) || (pTokens + cTokens);
        noteProviderOutcome({
          entry: entry.providerEntry,
          pool: "text",
          ok: true,
          latencyMs: Date.now() - startedAt,
          promptTokens: pTokens,
          completionTokens: cTokens,
          totalTokens: tTokens,
        });
      }
      return result;
    } catch (error: any) {
      lastError = error;
      const toolIgnored = isToolChoiceIgnoredError(error);
      if (!toolIgnored) {
        noteModelFailure(entry.label);
        if (entry.providerEntry) noteProviderOutcome({ entry: entry.providerEntry, pool: "text", ok: false, latencyMs: Date.now() - startedAt, error });
      }
      const next = usable[index + 1];
      console.warn(
        `[MODEL:TEXT] ${entry.label}=${entry.model.modelId} ${toolIgnored ? "bypassed (tool ignored)" : "failed"}; ` +
        `${next ? `next=${next.model.modelId}` : "no_more_models"}; ` +
        `error=${error?.message || error}`
      );
    }
  }
  if (lastTextFallback) {
    console.warn(`[MODEL:TEXT] all subsequent models failed; accepting fallback text result from ${lastTextFallback.entry.label}`);
    noteModelSuccess(lastTextFallback.entry.label);
    if (lastTextFallback.entry.providerEntry) {
      const pTokens = Number(lastTextFallback.result?.usage?.promptTokens) || 0;
      const cTokens = Number(lastTextFallback.result?.usage?.completionTokens) || 0;
      const tTokens = Number(lastTextFallback.result?.usage?.totalTokens) || (pTokens + cTokens);
      noteProviderOutcome({
        entry: lastTextFallback.entry.providerEntry,
        pool: "text",
        ok: true,
        latencyMs: Date.now() - lastTextFallback.startedAt,
        promptTokens: pTokens,
        completionTokens: cTokens,
        totalTokens: tTokens,
      });
    }
    return lastTextFallback.result;
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
function wrapChain(chain: { model: any; timeout: number; label: string; providerEntry?: LlmKeyEntry }[]): any {
  const wrapped = { ...chain[0].model };

  if (typeof chain[0].model.doGenerate === "function") {
    wrapped.doGenerate = (options: any) => callModelChain(chain, "doGenerate", options);
  }

  if (typeof chain[0].model.doStream === "function") {
    wrapped.doStream = (options: any) => callModelChain(chain, "doStream", options);
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

function buildChainEntries(
  entries: LlmKeyEntry[],
  labelPrefix = "workspace"
): { model: any; timeout: number; label: string; providerEntry?: LlmKeyEntry }[] {
  const stepTimeout = envTimeout("TEXT_PRIMARY_TIMEOUT_MS", 15_000);
  const lastTimeout = envTimeout("TEXT_RESERVE_TIMEOUT_MS", 40_000);
  return entries.map((entry, index) => {
    const provider = createOpenAI({
      baseURL: entry.baseUrl,
      apiKey: entry.key,
    });
    const keyFingerprint = createHash("sha1").update(entry.key).digest("hex").slice(0, 8);
    const model = provider.chat(entry.model) as any;
    // NOTE: Do NOT modify model.modelId ? AI SDK uses it as the actual model sent
    // to the API. Adding a fingerprint suffix breaks the API request with
    // "Model not found". Fingerprint goes in the label only (for logs).
    return {
      model,
      timeout: index === entries.length - 1 ? lastTimeout : stepTimeout,
      label: `${labelPrefix}:${entry.name}(${keyFingerprint})`,
      providerEntry: entry,
    };
  });
}

// The panel's "API key" text pool, when the operator filled it. Entries must be
// OpenAI-compatible (tool calls travel over chat-completions), so a gemini-typed
// entry is skipped with a note rather than silently breaking tools.
function workspaceTextChain(): { model: any; timeout: number; label: string; providerEntry?: LlmKeyEntry }[] {
  const pools = getLlmWorkspacePools();
  const openAiEntries = (pools?.text || []).filter((entry) => entry.type === "openai");
  if ((pools?.text || []).length !== openAiEntries.length) {
    console.warn("[MODEL:TEXT] workspace: gemini-typed text keys are not supported for tool-calling; skipped");
  }

  let entries = providersForRequest(openAiEntries, "text");
  if (!entries.length && openAiEntries.length > 0) {
    console.warn("[MODEL:TEXT] workspace: all text providers suspect/cooling down; keeping workspace entries to prevent empty chain starvation");
    entries = openAiEntries.filter((e) => (e as any).status !== "disabled" && e.health?.status !== "unavailable" && e.enabled !== false);
    if (!entries.length) entries = openAiEntries;
  }
  if (!entries.length) return [];

  return buildChainEntries(entries, "workspace");
}

export function resolveModel(_ctx: FastFoodContext) {
  // WhatsPro panel is the SINGLE source of truth for API keys.
  // The env OpenRouter chain (textModel) is only the absolute last resort
  // when the workspace panel is completely empty ? never appended to a
  // live workspace pool (a depleted env key would silently eat every
  // request that workspace already handled fine).
  const wsChain = workspaceTextChain();
  if (wsChain.length > 0) return wrapChain(wsChain);

  if (!process.env.OPENROUTER_API_KEY) {
    const pools = getLlmWorkspacePools();
    const emergencyEntries = (pools?.text || []).filter((entry) => entry.type === "openai" && entry.key);
    if (emergencyEntries.length > 0) {
      console.warn("[MODEL:TEXT] OpenRouter API key missing; using workspace OpenAI entries as emergency fallback");
      return wrapChain(buildChainEntries(emergencyEntries, "emergency"));
    }
  }

  return textModel; // workspace empty ? env chain only
}


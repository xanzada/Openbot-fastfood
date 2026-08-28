import { createOpenAI } from "@ai-sdk/openai";
import { getLlmWorkspacePools } from "./llmWorkspace.service.js";

export type LlmRole = "system" | "user" | "assistant";

export interface OpenRouterMessage {
  role: LlmRole;
  content: any;
}

export interface MediaRequest {
  prompt: string;
  base64: string;
  mimeType: string;
  systemPrompt?: string;
}

export interface TextModelChain {
  primary: string;
  fallback: string;
  reserve: string;
}

export function envText(name: string, fallback = "") {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}

function splitList(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function legacyGeminiKeys() {
  return [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
  ].map((key) => String(key || "").trim()).filter(Boolean);
}

export function getMediaPrimaryKeys() {
  return splitList(process.env.MEDIA_PRIMARY_KEYS || "").length
    ? splitList(process.env.MEDIA_PRIMARY_KEYS || "")
    : splitList(process.env.GEMINI_API_KEYS || "").length
      ? splitList(process.env.GEMINI_API_KEYS || "")
      : legacyGeminiKeys();
}

export function getTextModels(): TextModelChain {
  return {
    primary: envText("TEXT_PRIMARY_MODEL", "deepseek/deepseek-chat"),
    fallback: envText("TEXT_FALLBACK_MODEL", "deepseek/deepseek-chat-v3"),
    reserve: envText("TEXT_RESERVE_MODEL", "google/gemini-2.5-flash"),
  };
}

export function getMediaPrimaryModel() {
  const configured = envText(
    "MEDIA_PRIMARY_MODEL",
    envText("GEMINI_MEDIA_MODEL", envText("GEMINI_MODEL", "gemini-3.6-flash"))
  );
  return normalizeGeminiMediaModel(configured);
}

/**
 * Google answers 404 for retired direct-API media models, with a message naming the
 * replacement. A stale value therefore breaks every voice note and every receipt.
 *
 * Exported because the panel's key pool needs the same protection: each workspace
 * entry carries its own model string, typed by hand months ago, and those bypassed
 * this map entirely - on 2026-08-28 five of six Gemini entries answered
 * "models/gemini-2.5-flash is no longer available to new users" and the whole media
 * chain collapsed to the env reserve, which the key migration had already emptied.
 * A deliberate current-model override still passes through untouched.
 */
export function normalizeGeminiMediaModel(value: string) {
  const configured = String(value || "").trim();
  const normalized = configured.toLowerCase().replace(/^models\//, "");
  if (["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-1.5-flash", "gemini-1.5-pro"].includes(normalized)) {
    return "gemini-3.6-flash";
  }
  return configured;
}

export function getMediaFallbackModel() {
  return envText("MEDIA_FALLBACK_MODEL", envText("OPENROUTER_MEDIA_MODEL", "google/gemini-2.5-flash-lite"));
}

// Channel 2, kept entirely separate from the client pool: Google API keys from a
// billing-enabled project, which is what unlocks Pro quota. The free keys answer
// 429 for every Pro model, so this is the only official way to reach that tier
// on Google directly.
export function getMediaProKeys() {
  return splitList(process.env.MEDIA_PRO_KEYS || "");
}

export function getMediaProModel() {
  return envText("MEDIA_PRO_MODEL", "gemini-2.5-pro");
}

export function usesProMediaChannel() {
  const raw = String(process.env.MEDIA_PRO_ENABLED ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export function getOpenRouterProvider() {
  // The panel's API key page is the source of truth: the first
  // OpenAI-compatible entry (text pool, then media) carries the platform key.
  // Env stays as the fallback so a panel outage never silences the side lanes
  // (thinking, critic, shpor curation, memory, analytics).
  const pools = getLlmWorkspacePools();
  const key = pools?.text.find((entry) => entry.type === "openai")?.key
    || pools?.media.find((entry) => entry.type === "openai")?.key
    || envText("OPENROUTER_API_KEY");
  return createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: key,
  });
}

function isTransientStatus(status: number) {
  return status === 429 || status === 503;
}

function extractGeminiText(data: any) {
  return String(data?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "").trim();
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, ms = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function geminiPayload(request: MediaRequest) {
  const parts: Array<Record<string, unknown>> = [{ text: request.prompt }];
  if (request.base64) {
    parts.push({ inlineData: { mimeType: request.mimeType, data: request.base64 } });
  }
  return {
    systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : undefined,
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
    },
  };
}

// Where the next request starts its sweep. The keys are separate free-tier
// accounts, so always beginning at the first one drained its daily quota while
// the rest sat idle; every key still gets tried, only the entry point moves.
let mediaKeyCursor = 0;

export async function callGemini(request: MediaRequest) {
  return callGeminiChannel(request, getMediaPrimaryKeys(), getMediaPrimaryModel(), "gemini");
}

async function callGeminiChannel(request: MediaRequest, keys: string[], model: string, label: string) {
  const transientErrors: unknown[] = [];
  const hardErrors: unknown[] = [];
  const start = keys.length ? mediaKeyCursor % keys.length : 0;
  if (keys.length) mediaKeyCursor = (mediaKeyCursor + 1) % keys.length;

  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const index = (start + attempt) % keys.length;
    const key = keys[index];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload(request)),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const error = new Error(`GEMINI_MEDIA_${response.status}: ${errorText.slice(0, 240)}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      const text = extractGeminiText(await response.json());
      if (!text) throw new Error("GEMINI_MEDIA_EMPTY_RESPONSE");
      console.info(`[LLM:MEDIA] provider=${label} model=${model} key_index=${index + 1}/${keys.length}`);
      return text;
    } catch (error: any) {
      const status = Number(error?.status || 0);
      if (isTransientStatus(status)) {
        transientErrors.push(error);
        console.warn(`[LLM:MEDIA] ${label}_transient status=${status} key_index=${index + 1}/${keys.length}`);
        continue;
      }
      hardErrors.push(error);
      console.warn(`[LLM:MEDIA] ${label}_error status=${status || "-"} key_index=${index + 1}/${keys.length} error=${error?.message || error}`);
    }
  }

  if (!keys.length) {
    const error = new Error("MEDIA_PRIMARY_KEYS_NOT_CONFIGURED") as Error & { transientExhausted?: boolean };
    error.transientExhausted = true;
    throw error;
  }

  if (transientErrors.length === keys.length && hardErrors.length === 0) {
    const error = new Error("MEDIA_PRIMARY_KEYS_TRANSIENT_EXHAUSTED") as Error & { transientExhausted?: boolean };
    error.transientExhausted = true;
    throw error;
  }

  throw hardErrors[hardErrors.length - 1] || transientErrors[transientErrors.length - 1] || new Error("GEMINI_MEDIA_FAILED");
}

function getAudioFormat(mimeType = "") {
  const lower = String(mimeType).toLowerCase();
  const match = lower.match(/audio\/([a-z0-9]+)/);
  const raw = match ? match[1] : "";
  const map: Record<string, string> = {
    mpeg: "mp3",
    mp3: "mp3",
    wav: "wav",
    xwav: "wav",
    ogg: "ogg",
    opus: "ogg",
    webm: "ogg",
    mp4: "m4a",
    m4a: "m4a",
    aac: "aac",
    flac: "flac",
  };
  return map[raw] || raw || "wav";
}

function openRouterMediaPart(request: MediaRequest) {
  const dataUrl = `data:${request.mimeType};base64,${request.base64}`;
  if (request.mimeType.startsWith("image/")) return { type: "image_url", image_url: { url: dataUrl } };
  if (request.mimeType === "application/pdf") return { type: "file", file: { filename: "document.pdf", file_data: dataUrl } };
  if (request.mimeType.startsWith("audio/")) return { type: "input_audio", input_audio: { data: request.base64, format: getAudioFormat(request.mimeType) } };
  return { type: "file", file: { filename: "media", file_data: dataUrl } };
}

export async function callOpenRouter(request: MediaRequest) {
  return callOpenAiCompatible("https://openrouter.ai/api/v1", envText("OPENROUTER_API_KEY"), getMediaFallbackModel(), request);
}

/** Any OpenAI-compatible chat/completions endpoint, with an explicit base URL, key and model — the workspace pools use it entry by entry. */
export async function callOpenAiCompatible(baseUrl: string, apiKey: string, model: string, request: MediaRequest) {
  const trimmedKey = String(apiKey || "").trim();
  const base = String(baseUrl || "").trim().replace(/\/+$/, "") || "https://openrouter.ai/api/v1";
  if (!trimmedKey) throw new Error("OPENROUTER_API_KEY_NOT_CONFIGURED");

  // Text-only requests reach this reserve too (language detection, and any media
  // call whose payload never downloaded). Attaching an empty data URL made
  // OpenRouter reject the whole request with 400, so the reserve died exactly
  // when it was needed. Send the media part only when there is media.
  const mediaParts = request.base64 ? [openRouterMediaPart(request)] : [];
  const messages: OpenRouterMessage[] = [
    ...(request.systemPrompt ? [{ role: "system" as const, content: request.systemPrompt }] : []),
    { role: "user", content: [{ type: "text", text: request.prompt }, ...mediaParts] },
  ];

  const response = await fetchWithTimeout(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${trimmedKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`OPENAI_COMPATIBLE_${response.status}: ${errorText.slice(0, 240)}`);
  }

  const data = await response.json();
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("OPENAI_COMPATIBLE_EMPTY_RESPONSE");
  console.info(`[LLM:MEDIA] provider=openai-compatible base=${base} model=${model}`);
  return text;
}

/** Kept for existing callers: the OpenRouter lane with env key/model. */
export async function callOpenRouterWith(apiKey: string, model: string, request: MediaRequest) {
  return callOpenAiCompatible("https://openrouter.ai/api/v1", apiKey, model, request);
}

// MEDIA_USE_FREE_KEYS=false sends media straight to the paid reserve. The free
// Gemini keys have no Pro quota at all (every Pro model answers 429 on all of
// them), so Pro-tier reading is only reachable through OpenRouter.
export function usesFreeMediaKeys() {
  const raw = String(process.env.MEDIA_USE_FREE_KEYS ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !["0", "false", "no", "off"].includes(raw);
}

export async function generateMediaText(request: MediaRequest) {
  // Every failure is collected so the last-resort error names what actually went
  // wrong. It used to surface only the final env-channel message
  // (OPENROUTER_API_KEY_NOT_CONFIGURED), which is the least useful line in the
  // chain: it hid that six workspace keys had answered 404 and 402 first, and it
  // paged the owner with a cause that was not the cause (2026-08-28).
  const failures: string[] = [];

  // The panel-curated workspace pool goes first: every entry is tried in order,
  // a failing entry just means the next one. An empty or unreachable workspace
  // changes nothing — the platform-wide env channels below stand as before.
  const workspace = getLlmWorkspacePools();
  for (const entry of workspace?.media || []) {
    // A retired model string typed into the panel months ago is still a 404 today.
    // The env lane has normalised this since the model was retired; the workspace
    // lane did not, so five of six Gemini entries died on every receipt.
    const model = entry.type === "gemini" ? normalizeGeminiMediaModel(entry.model) : entry.model;
    try {
      const text = entry.type === "gemini"
        ? await callGeminiChannel(request, [entry.key], model, `workspace:${entry.name}`)
        : await callOpenAiCompatible(entry.baseUrl, entry.key, model, request);
      if (text) return text;
      failures.push(`${entry.name}:empty`);
    } catch (error: any) {
      failures.push(`${entry.name}:${String(error?.message || error).slice(0, 80)}`);
      console.warn(`[LLM:MEDIA] workspace_failed name=${entry.name} model=${model} error=${error?.message || error}`);
    }
  }

  // Channel 2 first when it is switched on: the paid Pro pool for our own
  // project. It never touches the client key pool below.
  if (usesProMediaChannel()) {
    const proKeys = getMediaProKeys();
    if (!proKeys.length) {
      console.warn("[LLM:MEDIA] MEDIA_PRO_ENABLED is on but MEDIA_PRO_KEYS is empty; falling through");
    } else {
      try {
        return await callGeminiChannel(request, proKeys, getMediaProModel(), "gemini_pro");
      } catch (error: any) {
        failures.push(`pro:${String(error?.message || error).slice(0, 80)}`);
        console.warn(`[LLM:MEDIA] pro_channel_failed reason=${error?.message || error}`);
      }
    }
  }

  // Channel 1: the free key pool the client instances run on.
  const openRouterKey = envText("OPENROUTER_API_KEY");
  if (!usesFreeMediaKeys()) {
    console.info(`[LLM:MEDIA] provider=openrouter reason=free_keys_disabled model=${getMediaFallbackModel()}`);
    if (openRouterKey) return callOpenRouter(request);
    failures.push("openrouter:key_missing");
    throw new Error(`MEDIA_ALL_CHANNELS_FAILED: ${failures.join(" | ")}`);
  }
  try {
    return await callGemini(request);
  } catch (error: any) {
    // Gemini produced no answer on any key. Which way it failed does not change
    // that: a retired model 404s hard, and this branch used to fire only for an
    // all-429 sweep, so a paid OpenRouter fallback sat unused while receipts
    // came back as "could not process the file".
    failures.push(`gemini_env:${String(error?.message || error).slice(0, 80)}`);
    console.warn(`[LLM:MEDIA] failover=openrouter reason=${error?.message || error}`);
    // The env reserve is empty by design since the keys moved into the panel, so
    // calling it would raise OPENROUTER_API_KEY_NOT_CONFIGURED and bury every real
    // failure above it. Report the whole chain instead.
    if (!openRouterKey) throw new Error(`MEDIA_ALL_CHANNELS_FAILED: ${failures.join(" | ")}`);
    return callOpenRouter(request);
  }
}

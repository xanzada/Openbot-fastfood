import { createOpenAI } from "@ai-sdk/openai";
function envText(name, fallback = "") {
  const value = String(process.env[name] || "").trim();
  return value || fallback;
}
function splitList(value = "") {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}
function legacyGeminiKeys() {
  return [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6
  ].map((key) => String(key || "").trim()).filter(Boolean);
}
function getMediaPrimaryKeys() {
  return splitList(process.env.MEDIA_PRIMARY_KEYS || "").length ? splitList(process.env.MEDIA_PRIMARY_KEYS || "") : splitList(process.env.GEMINI_API_KEYS || "").length ? splitList(process.env.GEMINI_API_KEYS || "") : legacyGeminiKeys();
}
function getTextModels() {
  return {
    primary: envText("TEXT_PRIMARY_MODEL", "deepseek/deepseek-chat"),
    fallback: envText("TEXT_FALLBACK_MODEL", "deepseek/deepseek-chat-v3")
  };
}
function getMediaPrimaryModel() {
  return envText("MEDIA_PRIMARY_MODEL", envText("GEMINI_MEDIA_MODEL", envText("GEMINI_MODEL", "gemini-2.5-flash-lite")));
}
function getMediaFallbackModel() {
  return envText("MEDIA_FALLBACK_MODEL", envText("OPENROUTER_MEDIA_MODEL", "google/gemini-2.5-flash-lite"));
}
function getOpenRouterProvider() {
  return createOpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: process.env.OPENROUTER_API_KEY
  });
}
function isTransientStatus(status) {
  return status === 429 || status === 503;
}
function extractGeminiText(data) {
  return String(data?.candidates?.[0]?.content?.parts?.map((part) => part?.text || "").join("") || "").trim();
}
async function fetchWithTimeout(url, options = {}, ms = 3e4) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function geminiPayload(request) {
  const parts = [{ text: request.prompt }];
  if (request.base64) {
    parts.push({ inlineData: { mimeType: request.mimeType, data: request.base64 } });
  }
  return {
    systemInstruction: request.systemPrompt ? { parts: [{ text: request.systemPrompt }] } : void 0,
    contents: [
      {
        role: "user",
        parts
      }
    ],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json"
    }
  };
}
async function callGemini(request) {
  const keys = getMediaPrimaryKeys();
  const model = getMediaPrimaryModel();
  const transientErrors = [];
  const hardErrors = [];
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload(request))
      });
      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        const error = new Error(`GEMINI_MEDIA_${response.status}: ${errorText.slice(0, 240)}`);
        error.status = response.status;
        throw error;
      }
      const text = extractGeminiText(await response.json());
      if (!text) throw new Error("GEMINI_MEDIA_EMPTY_RESPONSE");
      console.info(`[LLM:MEDIA] provider=gemini model=${model} key_index=${index + 1}/${keys.length}`);
      return text;
    } catch (error) {
      const status = Number(error?.status || 0);
      if (isTransientStatus(status)) {
        transientErrors.push(error);
        console.warn(`[LLM:MEDIA] gemini_transient status=${status} key_index=${index + 1}/${keys.length}`);
        continue;
      }
      hardErrors.push(error);
      console.warn(`[LLM:MEDIA] gemini_error status=${status || "-"} key_index=${index + 1}/${keys.length} error=${error?.message || error}`);
    }
  }
  if (!keys.length) {
    const error = new Error("MEDIA_PRIMARY_KEYS_NOT_CONFIGURED");
    error.transientExhausted = true;
    throw error;
  }
  if (transientErrors.length === keys.length && hardErrors.length === 0) {
    const error = new Error("MEDIA_PRIMARY_KEYS_TRANSIENT_EXHAUSTED");
    error.transientExhausted = true;
    throw error;
  }
  throw hardErrors[hardErrors.length - 1] || transientErrors[transientErrors.length - 1] || new Error("GEMINI_MEDIA_FAILED");
}
function getAudioFormat(mimeType = "") {
  const lower = String(mimeType).toLowerCase();
  const match = lower.match(/audio\/([a-z0-9]+)/);
  const raw = match ? match[1] : "";
  const map = {
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
    flac: "flac"
  };
  return map[raw] || raw || "wav";
}
function openRouterMediaPart(request) {
  const dataUrl = `data:${request.mimeType};base64,${request.base64}`;
  if (request.mimeType.startsWith("image/")) return { type: "image_url", image_url: { url: dataUrl } };
  if (request.mimeType === "application/pdf") return { type: "file", file: { filename: "document.pdf", file_data: dataUrl } };
  if (request.mimeType.startsWith("audio/")) return { type: "input_audio", input_audio: { data: request.base64, format: getAudioFormat(request.mimeType) } };
  return { type: "file", file: { filename: "media", file_data: dataUrl } };
}
async function callOpenRouter(request) {
  const apiKey = envText("OPENROUTER_API_KEY");
  if (!apiKey) throw new Error("OPENROUTER_API_KEY_NOT_CONFIGURED");
  const model = getMediaFallbackModel();
  const messages = [
    ...request.systemPrompt ? [{ role: "system", content: request.systemPrompt }] : [],
    { role: "user", content: [{ type: "text", text: request.prompt }, openRouterMediaPart(request)] }
  ];
  const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages
    })
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`OPENROUTER_MEDIA_${response.status}: ${errorText.slice(0, 240)}`);
  }
  const data = await response.json();
  const text = String(data?.choices?.[0]?.message?.content || "").trim();
  if (!text) throw new Error("OPENROUTER_MEDIA_EMPTY_RESPONSE");
  console.info(`[LLM:MEDIA] provider=openrouter model=${model}`);
  return text;
}
async function generateMediaText(request) {
  try {
    return await callGemini(request);
  } catch (error) {
    if (error?.transientExhausted === true) {
      console.warn(`[LLM:MEDIA] failover=openrouter reason=${error?.message || error}`);
      return callOpenRouter(request);
    }
    throw error;
  }
}
export {
  callGemini,
  callOpenRouter,
  generateMediaText,
  getMediaFallbackModel,
  getMediaPrimaryKeys,
  getMediaPrimaryModel,
  getOpenRouterProvider,
  getTextModels
};

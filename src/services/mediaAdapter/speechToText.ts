import { getLlmWorkspacePools, type LlmKeyEntry } from "../llmWorkspace.service.js";
import { getMediaPrimaryKeys, normalizeGeminiMediaModel } from "../llm.service.js";

function getAudioExtension(mimeType: string): string {
  const lower = String(mimeType || "").toLowerCase();
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mp4") || lower.includes("m4a")) return "m4a";
  if (lower.includes("aac")) return "aac";
  if (lower.includes("flac")) return "flac";
  return "mp3";
}

async function transcribeWithWhisperApi(
  baseUrl: string,
  apiKey: string,
  model: string,
  audioBuffer: Buffer,
  mimeType: string,
  langHint?: "kk" | "ru"
): Promise<string> {
  const base = String(baseUrl || "").replace(/\/+$/, "") || "https://api.groq.com/openai/v1";
  const ext = getAudioExtension(mimeType);
  const formData = new FormData();
  const blob = new Blob([audioBuffer as any], { type: mimeType || "audio/ogg" });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", model || "whisper-large-v3-turbo");
  formData.append("response_format", "json");
  if (langHint) {
    formData.append("language", langHint === "kk" ? "kk" : "ru");
  }

  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: formData,
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`WHISPER_API_${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as { text?: string };
  const transcript = String(data?.text || "").trim();
  if (!transcript) throw new Error("WHISPER_EMPTY_TRANSCRIPT");
  return transcript;
}

async function transcribeWithGeminiAudio(
  baseUrl: string,
  apiKey: string,
  model: string,
  audioBuffer: Buffer,
  mimeType: string
): Promise<string> {
  const base = String(baseUrl || "").replace(/\/+$/, "") || "https://generativelanguage.googleapis.com/v1beta";
  const normalizedModel = normalizeGeminiMediaModel(model || "gemini-2.5-flash");
  const url = `${base}/models/${encodeURIComponent(normalizedModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: "Transcribe this customer voice message verbatim in the original spoken language (Kazakh, Russian, or mixed). Do not answer, do not translate, do not add any markdown or commentary. Return only the exact transcribed speech text.",
            },
            {
              inlineData: {
                mimeType: mimeType || "audio/ogg",
                data: audioBuffer.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        maxOutputTokens: 2048,
      },
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`GEMINI_AUDIO_${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as any;
  const transcript = String(data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("") || "").trim();
  if (!transcript) throw new Error("GEMINI_EMPTY_AUDIO_RESPONSE");
  return transcript;
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType = "audio/ogg",
  langHint?: "kk" | "ru"
): Promise<string> {
  if (!audioBuffer || audioBuffer.length === 0) return "";

  const workspace = getLlmWorkspacePools();
  const sttEntries: LlmKeyEntry[] = workspace?.stt || [];

  // 1. Try workspace STT entries in priority order
  for (const entry of sttEntries) {
    if (!entry.key || (entry as any).enabled === false) continue;
    const startedAt = Date.now();
    try {
      let transcript = "";
      if (entry.type === "gemini") {
        transcript = await transcribeWithGeminiAudio(entry.baseUrl, entry.key, entry.model, audioBuffer, mimeType);
      } else {
        transcript = await transcribeWithWhisperApi(entry.baseUrl, entry.key, entry.model, audioBuffer, mimeType, langHint);
      }
      if (transcript) {
        console.info(`[UMA:STT] transcribed via workspace ${entry.name} (${entry.model}) in ${Date.now() - startedAt}ms: "${transcript.slice(0, 60)}"`);
        return transcript;
      }
    } catch (err) {
      console.warn(`[UMA:STT] entry ${entry.name} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // 2. Fallback to Gemini Primary free keys rotation (0% host CPU / 0% RAM)
  const geminiKeys = getMediaPrimaryKeys();
  for (let i = 0; i < geminiKeys.length; i++) {
    const key = geminiKeys[i];
    if (!key) continue;
    try {
      const startedAt = Date.now();
      const transcript = await transcribeWithGeminiAudio(
        "https://generativelanguage.googleapis.com/v1beta",
        key,
        "gemini-2.5-flash",
        audioBuffer,
        mimeType
      );
      if (transcript) {
        console.info(`[UMA:STT] transcribed via Gemini free key #${i + 1} fallback in ${Date.now() - startedAt}ms: "${transcript.slice(0, 60)}"`);
        return transcript;
      }
    } catch (err) {
      console.warn(`[UMA:STT] Gemini free key #${i + 1} failed:`, err instanceof Error ? err.message : err);
    }
  }

  throw new Error("ALL_STT_PROVIDERS_FAILED");
}

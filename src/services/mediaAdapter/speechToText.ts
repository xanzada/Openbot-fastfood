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

function cleanTranscript(raw: string): string {
  let text = String(raw || "").trim();
  // Strip common AI prefixes
  text = text.replace(/^(транскрипция|расшифровка|текст|transcript|audio text)[:\s]*/iu, "");
  // Strip surrounding quotes or markdown
  text = text.replace(/^["'«»“”„`]+|["'«»“”„`]+$/g, "").trim();
  return text;
}

const BILINGUAL_FASTFOOD_PROMPT =
  "Сәлеметсіз бе! Тапсырыс берейін деп едім: донер, шаурма, пицца, лаваш, сырный бургер, фри, наггетс, кока-кола. Қанша болады? Kaspi Gold, аударым, төлем, чек, мекенжай, жеткізу, рақмет. Здравствуйте! Хочу сделать заказ: доставка, самовывоз, оплата Kaspi, чек.";

async function transcribeWithWhisperApi(
  baseUrl: string,
  apiKey: string,
  model: string,
  audioBuffer: Buffer,
  mimeType: string,
  langHint?: "kk" | "ru",
  externalSignal?: AbortSignal,
): Promise<string> {
  const base = String(baseUrl || "").replace(/\/+$/, "") || "https://api.groq.com/openai/v1";
  const ext = getAudioExtension(mimeType);
  const formData = new FormData();
  const blob = new Blob([audioBuffer as any], { type: mimeType || "audio/ogg" });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", model || "whisper-large-v3-turbo");
  formData.append("response_format", "json");
  formData.append("temperature", "0");
  formData.append("prompt", BILINGUAL_FASTFOOD_PROMPT);

  if (langHint) {
    formData.append("language", langHint === "kk" ? "kk" : "ru");
  }

  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: formData,
    signal: externalSignal
      ? AbortSignal.any([externalSignal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`WHISPER_API_${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as { text?: string };
  const transcript = cleanTranscript(data?.text || "");
  if (!transcript) throw new Error("WHISPER_EMPTY_TRANSCRIPT");
  return transcript;
}

async function transcribeWithGeminiAudio(
  baseUrl: string,
  apiKey: string,
  model: string,
  audioBuffer: Buffer,
  mimeType: string,
  externalSignal?: AbortSignal,
): Promise<string> {
  const base = String(baseUrl || "").replace(/\/+$/, "") || "https://generativelanguage.googleapis.com/v1beta";
  const normalizedModel = normalizeGeminiMediaModel(model || "gemini-2.5-flash");
  const url = `${base}/models/${encodeURIComponent(normalizedModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

  const kazakhRussianTranscriptionInstruction = `
Сіз — Қазақстандағы клиенттердің дауыстық хабарламаларын сөзбе-сөз мәтінге айналдыратын сарапшы транскрипторсыз (Kazakhstan bilingual STT specialist: Kazakh & Russian).

МІНДЕТ: Аудиожазбаны айтылған тілінде (қазақша, орысша немесе аралас) өте анық әрі нақты мәтінге айналдырыңыз.

МАҢЫЗДЫ ЕРЕЖЕЛЕР:
1. ҚАЗАҚША СӨЙЛЕСЕ:
   - Қазақ әліпбиінің төл әріптерін толық әрі дұрыс жазыңыз: ә, і, ң, ғ, ү, ұ, қ, ө, һ.
   - Мысалы: "қанша", "жеткізу", "өтінемін", "ірімшік", "үш", "рақмет", "ақша", "қосымша", "қайырлы күн".
   - Қазақ әріптерін орыс әріптерімен алмастырмаңыз (мысалы "канша", "жеткизу", "отинемин" деп жазуға қатаң тыйым салынады!).

2. ОРЫСША СӨЙЛЕСЕ:
   - Стандартты орыс кириллицасымен грамматикалық дұрыс жазыңыз (мысалы: "Здравствуйте, можно один сырный донер и колу?", "Сколько будет с доставкой?", "Оплату перевел на Каспи").

3. АРАЛАС СӨЙЛЕСЕ (Қазақша + Орысша / Код-ауыстыру):
   - Қалай айтылса, сол күйінде сөзбе-сөз жазыңыз (мысалы: "Маған екі сырный донер, бір фри және кола, оплата каспимен болады ма?").
   - Сөздерді аудармаңыз, бір тілге күштеп бейімдемеңіз.

4. ТАҒАМДАР МЕН ТӨЛЕМ ТЕРМИНДЕРІ:
   - Тағамдар: донер, шаурма, пицца, лаваш, бургер, сырный, фри, наггетс, сэндвич, хот-дог, соус.
   - Сусындар: кока-кола, фанта, спрайт, шырын, шәй, кофе, айран, су.
   - Төлем және жеткізу: Kaspi, Kaspi Gold, аударым, төлем, чек, квитанция, жеткізу, адрес, мекенжай, подъезд, этаж, сдача.

5. ТАЛАП:
   - Тек қана айтылған сөздерді қайтарыңыз!
   - Жауап бермеңіз, түсініктеме қоспаңыз, тырнақша қоймаңыз, аударма жасамаңыз.
`.trim();

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: kazakhRussianTranscriptionInstruction,
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
    signal: externalSignal
      ? AbortSignal.any([externalSignal, AbortSignal.timeout(25_000)])
      : AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`GEMINI_AUDIO_${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = (await response.json()) as any;
  const rawText = String(data?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text || "").join("") || "").trim();
  const transcript = cleanTranscript(rawText);
  if (!transcript) throw new Error("GEMINI_EMPTY_AUDIO_RESPONSE");
  return transcript;
}

export function isCompatibleWorkspaceSttEntry(entry: LlmKeyEntry) {
  if (!entry?.key || (entry as any).enabled === false) return false;
  const type = String(entry.type || "").toLowerCase();
  const model = String(entry.model || "").toLowerCase();
  const baseUrl = String(entry.baseUrl || "").toLowerCase();
  if (type === "gemini") {
    return model.startsWith("gemini-")
      && (!baseUrl || baseUrl.includes("generativelanguage.googleapis.com"));
  }
  return type === "groq" || model.includes("whisper");
}

export async function raceHedgedBatch<T, R>(
  items: T[],
  attempt: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal,
) {
  const controllers = items.map(() => new AbortController());
  try {
    const winner = await Promise.any(items.map(async (item, index) => {
      const combined = signal
        ? AbortSignal.any([signal, controllers[index].signal])
        : controllers[index].signal;
      return { value: await attempt(item, index, combined), index };
    }));
    controllers.forEach((controller, index) => {
      if (index !== winner.index && !controller.signal.aborted) controller.abort();
    });
    return winner;
  } catch (error) {
    controllers.forEach((controller) => {
      if (!controller.signal.aborted) controller.abort();
    });
    throw error;
  }
}

export async function transcribeWithHedgedGeminiKeys(
  keys: string[],
  audioBuffer: Buffer,
  mimeType: string,
  signal?: AbortSignal,
  width = 4,
): Promise<string> {
  const usable = keys.filter(Boolean);
  const batchSize = Math.max(1, Math.min(4, Number(width) || 4));
  for (let offset = 0; offset < usable.length; offset += batchSize) {
    if (signal?.aborted) throw signal.reason || new Error("STT_BUDGET_EXHAUSTED");
    const batch = usable.slice(offset, offset + batchSize);
    try {
      const winner = await raceHedgedBatch(batch, async (key, index, attemptSignal) => {
        const startedAt = Date.now();
        try {
          const transcript = await transcribeWithGeminiAudio(
            "https://generativelanguage.googleapis.com/v1beta",
            key,
            "gemini-2.5-flash",
            audioBuffer,
            mimeType,
            attemptSignal,
          );
          return { transcript, elapsedMs: Date.now() - startedAt };
        } catch (error) {
          if (!attemptSignal.aborted) {
            console.warn(`[UMA:STT] Gemini free key #${offset + index + 1} failed:`, error instanceof Error ? error.message : error);
          }
          throw error;
        }
      }, signal);
      const winnerIndex = offset + winner.index;
      console.info(`[UMA:STT] transcribed via Gemini free key #${winnerIndex + 1} hedged fallback in ${winner.value.elapsedMs}ms: "${winner.value.transcript.slice(0, 60)}"`);
      return winner.value.transcript;
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
    }
  }
  throw new Error("ALL_GEMINI_STT_KEYS_FAILED");
}

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType = "audio/ogg",
  langHint?: "kk" | "ru"
): Promise<string> {
  if (!audioBuffer || audioBuffer.length === 0) return "";

  const workspace = getLlmWorkspacePools();
  const sttEntries: LlmKeyEntry[] = (workspace?.stt || []).filter(isCompatibleWorkspaceSttEntry);
  const budgetMs = Math.max(5_000, Math.min(25_000, Number(process.env.STT_TOTAL_BUDGET_MS || 15_000)));
  const budgetSignal = AbortSignal.timeout(budgetMs);

  // Collect candidate STT entries from workspace (stt, groq in media/text, gemini in media/text)
  const candidateEntries: LlmKeyEntry[] = [...sttEntries];

  // Auto-discover Groq or Gemini keys from media and text pools if stt pool is empty
  const allPools = [...(workspace?.media || []), ...(workspace?.text || [])];
  for (const entry of allPools) {
    if (!isCompatibleWorkspaceSttEntry(entry)) continue;
    if (!candidateEntries.some((candidate) => candidate.key === entry.key)) candidateEntries.push(entry);
  }

  // 1. Try workspace candidate entries in priority order
  for (const entry of candidateEntries) {
    const startedAt = Date.now();
    try {
      let transcript = "";
      if (entry.type === "gemini") {
        transcript = await transcribeWithGeminiAudio(entry.baseUrl, entry.key, entry.model, audioBuffer, mimeType, budgetSignal);
      } else {
        transcript = await transcribeWithWhisperApi(entry.baseUrl, entry.key, entry.model, audioBuffer, mimeType, langHint, budgetSignal);
      }
      if (transcript) {
        console.info(`[UMA:STT] transcribed via workspace ${entry.name} (${entry.model}) in ${Date.now() - startedAt}ms: "${transcript.slice(0, 60)}"`);
        return transcript;
      }
    } catch (err) {
      console.warn(`[UMA:STT] entry ${entry.name} failed:`, err instanceof Error ? err.message : err);
    }
  }

  // 2. Try environment Groq key if available
  const groqEnvKey = String(process.env.GROQ_API_KEY || "").trim();
  if (groqEnvKey) {
    try {
      const startedAt = Date.now();
      const transcript = await transcribeWithWhisperApi(
        "https://api.groq.com/openai/v1",
        groqEnvKey,
        "whisper-large-v3-turbo",
        audioBuffer,
        mimeType,
        langHint,
        budgetSignal,
      );
      if (transcript) {
        console.info(`[UMA:STT] transcribed via env GROQ_API_KEY in ${Date.now() - startedAt}ms: "${transcript.slice(0, 60)}"`);
        return transcript;
      }
    } catch (err) {
      console.warn("[UMA:STT] env GROQ_API_KEY failed:", err instanceof Error ? err.message : err);
    }
  }

  // 3. Fallback to Gemini Primary free keys rotation (0% host CPU / 0% RAM)
  const geminiKeys = getMediaPrimaryKeys();
  try {
    return await transcribeWithHedgedGeminiKeys(geminiKeys, audioBuffer, mimeType, budgetSignal);
  } catch (error) {
    console.warn("[UMA:STT] hedged Gemini fallback failed:", error instanceof Error ? error.message : error);
  }

  throw new Error("ALL_STT_PROVIDERS_FAILED");
}

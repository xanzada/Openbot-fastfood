import test from "node:test";
import assert from "node:assert/strict";
import {
  isCompatibleWorkspaceSttEntry,
  raceHedgedBatch,
} from "../src/services/mediaAdapter/speechToText.js";
import { answerVoiceMenuOverview, isVoiceMenuOverview } from "../src/services/turnSafetyNet.service.js";

test("an OpenRouter chat model mislabeled as Gemini is never used as STT", () => {
  assert.equal(isCompatibleWorkspaceSttEntry({
    name: "openrouter2", type: "gemini", model: "openai/gpt-4o-mini",
    baseUrl: "https://openrouter.ai/api/v1", key: "test",
  } as any), false);
  assert.equal(isCompatibleWorkspaceSttEntry({
    name: "gemini", type: "gemini", model: "gemini-2.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta", key: "test",
  } as any), true);
});

test("STT attempts are hedged instead of waiting through failures serially", async () => {
  const starts: number[] = [];
  const winner = await raceHedgedBatch(["k1", "k2", "k3", "k4"], async (key, _index, signal) => {
    starts.push(Date.now());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, key === "k4" ? 25 : 80);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    });
    if (key !== "k4") throw new Error("busy");
    return "Сіздерде не бар?";
  });
  assert.equal(winner.value, "Сіздерде не бар?");
  assert.equal(winner.index, 3);
  assert.equal(starts.length, 4);
  assert.ok(Math.max(...starts) - Math.min(...starts) < 50, `keys did not start together: ${starts}`);
});

test("a truncated voice menu question is answered from live menu facts without a text LLM", async () => {
  const ctx = {
    language: "kk", text: "Саламатсыз ба, мен заказ берейін дегем, сіздерде не",
    mediaContext: { kind: "audio", mimeType: "audio/ogg" },
    activeShiftNotes: [],
    menuSnapshot: { items: [
      { name: "Тауық донер", category_name: "Донер", price: 1800, available: true },
      { name: "Гриль", category_name: "Гриль", price: 2600, available: true },
      { name: "Цезарь", category_name: "Салат", price: 2200, available: true },
    ] },
  } as any;
  assert.equal(isVoiceMenuOverview(ctx), true);
  let grants = 0;
  const reply = await answerVoiceMenuOverview(ctx, async () => { grants += 1; return true; });
  assert.equal(grants, 1);
  assert.match(String(reply), /Тауық донер — 1800 ₸/);
  assert.match(String(reply), /Гриль — 2600 ₸/);
  assert.match(String(reply), /Цезарь — 2200 ₸/);
  assert.doesNotMatch(String(reply), /көмектесуге дайынмын|сұрақтарыңыз болса/iu);
});

test("voice menu examples obey sold-out and operator-note restrictions", async () => {
  const ctx = {
    language: "ru", text: "Что у вас есть в меню?",
    mediaContext: { kind: "audio" },
    activeShiftNotes: [{ noteId: "note-sushi", text: "суши нет пока что" }],
    menuSnapshot: { items: [
      { name: "Филадельфия суши", category_name: "Суши", price: 3000 },
      { name: "Бургер", category_name: "Бургеры", price: 1900, available: false },
      { name: "Пицца", category_name: "Пицца", price: 2800, available: true },
    ] },
  } as any;
  const reply = await answerVoiceMenuOverview(ctx, async () => false);
  assert.match(String(reply), /Пицца — 2800 ₸/);
  assert.doesNotMatch(String(reply), /Филадельфия|Бургер/);
});

test("the webhook uses the deterministic voice-menu reply before the general agent", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const transcriptBranch = source.slice(source.indexOf("const transcript = voiceTranscriptForAgent"), source.indexOf('if (mediaAnalysis.type === "complaint")'));
  assert.match(transcriptBranch, /answerVoiceMenuOverview\(ctx\)/);
  assert.match(transcriptBranch, /mediaPreemptiveSource = "voice_menu_overview"/);
  assert.ok(source.indexOf('if (mediaPreemptiveReply) {') < source.indexOf("const operationalReply = operationalPreemptionReply(ctx)"));
});

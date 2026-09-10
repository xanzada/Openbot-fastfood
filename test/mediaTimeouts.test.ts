import assert from "node:assert/strict";
import test from "node:test";
import { fetchTextWithTimeout } from "../src/services/llm.service.js";
import {
  extractInboundMedia,
  getBase64Media,
  readResponseBodyLimited,
} from "../src/services/inboundGuard.service.js";

test("provider timeout remains active while the response body is being read", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => ({
    ok: true,
    status: 200,
    text: () => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    }),
  }) as Response);

  await assert.rejects(fetchTextWithTimeout("https://example.invalid", {}, 20), { name: "AbortError" });
});

test("streamed media is rejected as soon as it exceeds its byte limit", async () => {
  const response = new Response(new Uint8Array([1, 2, 3, 4, 5]));
  await assert.rejects(readResponseBodyLimited(response, 4), { message: "MEDIA_TOO_LARGE" });
});

test("inbound media download timeout returns the existing safe failure", async (t) => {
  const body = {
    type: "image",
    hasMedia: true,
    mimeType: "image/png",
    downloadUrl: "https://example.invalid/media",
  };
  const media = extractInboundMedia(body);
  assert.ok(media);

  t.mock.method(console, "error", () => {});
  t.mock.method(globalThis, "fetch", async (_url, options) => new Promise<Response>((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    });
  }));

  assert.deepEqual(await getBase64Media(body, media, { timeoutMs: 20 }), { error: "media_download_failed" });
});

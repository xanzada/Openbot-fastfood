import test from "node:test";
import assert from "node:assert/strict";
import { extractInboundMedia, hydrateInboundMedia } from "../src/services/inboundGuard.service.js";

test("hydrateInboundMedia revalidates WhatsApp PDF receipts after download", async () => {
  const body = {
    hasMedia: true,
    downloadUrl: "https://example.com/receipt.pdf",
    data: {
      message: {
        documentMessage: {
          fileLength: 2048,
          caption: "Kaspi receipt",
        },
      },
    },
  };

  const initialMedia = extractInboundMedia(body);
  assert.ok(initialMedia);
  assert.equal(initialMedia.valid, false);
  assert.equal(initialMedia.reason, "missing_mime_type");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Buffer.from("%PDF-1.4 test"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    })) as typeof fetch;

  try {
    const hydrated = await hydrateInboundMedia(body, initialMedia);
    assert.ok(hydrated);
    assert.ok(hydrated.base64?.startsWith("data:application/pdf;base64,"));
    assert.equal(hydrated.valid, true);
    assert.equal(hydrated.reason, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

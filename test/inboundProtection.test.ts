import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_IMAGE_BYTES,
  MAX_VOICE_SECONDS,
  detectOggOpusDurationSeconds,
  extractInboundMedia,
  safeMediaMetadata,
} from "../src/services/inboundGuard.service.js";

test("oversized photos are rejected before AI processing", () => {
  const media = extractInboundMedia({
    type: "image",
    hasMedia: true,
    mediaType: "image/jpeg",
    fileLength: MAX_IMAGE_BYTES + 1,
  });
  assert.equal(media?.kind, "image");
  assert.equal(media?.valid, false);
  assert.equal(media?.reason, "media_too_large");
});

test("Ogg Opus granule duration detects long voice without gateway seconds", () => {
  const page = Buffer.alloc(27);
  page.write("OggS", 0, "ascii");
  page.writeBigUInt64LE(BigInt((MAX_VOICE_SECONDS + 1) * 48000), 6);
  page[26] = 0;
  assert.equal(Math.round(detectOggOpusDurationSeconds(page.toString("base64"))), MAX_VOICE_SECONDS + 1);
});

test("video is recognized but intentionally unsupported", () => {
  const media = extractInboundMedia({ type: "video", hasMedia: true, mediaType: "video/mp4" });
  assert.equal(media?.kind, "video");
  assert.equal(media?.valid, false);
  assert.equal(media?.reason, "video_unsupported");
});

test("stickers are accepted as ephemeral non-AI media", () => {
  const media = extractInboundMedia({ type: "sticker" });
  assert.equal(media?.kind, "sticker");
  assert.equal(media?.valid, true);
});

test("WhatsPro ptt is accepted but music and long voice are rejected", () => {
  const voice = extractInboundMedia({ type: "ptt", mediaKind: "ptt", hasMedia: true, mediaType: "audio/ogg", seconds: 30 });
  const music = extractInboundMedia({ type: "audio", hasMedia: true, mediaType: "audio/mpeg", seconds: 30 });
  const longVoice = extractInboundMedia({ type: "ptt", mediaKind: "ptt", hasMedia: true, mediaType: "audio/ogg", seconds: MAX_VOICE_SECONDS + 1 });
  assert.equal(voice?.valid, true);
  assert.equal(voice?.isVoiceNote, true);
  assert.equal(music?.reason, "music_audio_not_supported");
  assert.equal(longVoice?.reason, "voice_too_long");
});

test("safe media metadata never retains binary payload", () => {
  const safe = safeMediaMetadata({
    hasMedia: true,
    kind: "image",
    mimeType: "image/jpeg",
    sizeBytes: 100,
    valid: true,
    flags: [],
    base64: "SECRET_BASE64",
    dataUrl: "data:image/jpeg;base64,SECRET_BASE64",
    historyLabel: "[Photo sent]",
  });
  assert.equal(Object.hasOwn(safe || {}, "base64"), false);
  assert.equal(Object.hasOwn(safe || {}, "dataUrl"), false);
});

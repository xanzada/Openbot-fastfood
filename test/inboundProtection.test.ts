import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import {
  MAX_IMAGE_BYTES,
  MAX_AUDIO_BYTES,
  MAX_DOCUMENT_BYTES,
  OPERATOR_ACTIVE_SECONDS,
  detectOggOpusDurationSeconds,
  extractInboundMedia,
  safeMediaMetadata,
  shouldIgnoreSavedContacts,
} from "../src/services/inboundGuard.service.js";

test("operator handoff defaults to 40 seconds and saved contacts are protected by default", () => {
  assert.equal(OPERATOR_ACTIVE_SECONDS, 40);
  assert.equal(shouldIgnoreSavedContacts({}), true);
  assert.equal(shouldIgnoreSavedContacts({ BOT_IGNORE_SAVED_CONTACTS: "false" }), false);
});

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

test("Ogg Opus granule duration remains metadata without gateway seconds", () => {
  const page = Buffer.alloc(27);
  page.write("OggS", 0, "ascii");
  page.writeBigUInt64LE(BigInt(181 * 48000), 6);
  page[26] = 0;
  assert.equal(Math.round(detectOggOpusDurationSeconds(page.toString("base64"))), 181);
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

test("supported ordinary audio and long PTT are accepted without product duration refusal", () => {
  const voice = extractInboundMedia({ type: "ptt", mediaKind: "ptt", hasMedia: true, mediaType: "audio/ogg", seconds: 30 });
  const music = extractInboundMedia({ type: "audio", hasMedia: true, mediaType: "audio/mpeg", seconds: 30 });
  const longVoice = extractInboundMedia({ type: "ptt", mediaKind: "ptt", hasMedia: true, mediaType: "audio/ogg", seconds: 181 });
  assert.equal(voice?.valid, true);
  assert.equal(voice?.isVoiceNote, true);
  assert.equal(music?.valid, true);
  assert.equal(music?.isVoiceNote, false);
  assert.equal(longVoice?.valid, true);
  assert.equal(longVoice?.durationSeconds, 181);
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

test("all supported media kinds share the default 64MiB resource bound", () => {
  assert.equal(MAX_AUDIO_BYTES, 64 * 1024 * 1024);
  assert.equal(MAX_IMAGE_BYTES, MAX_AUDIO_BYTES);
  assert.equal(MAX_DOCUMENT_BYTES, MAX_AUDIO_BYTES);
});

test("the shared resource setting controls every media kind in a fresh module", () => {
  const script = `
    globalThis.fetch = async () => new Response("{}", {headers: {"Content-Type":"application/json"}});
    const guard = await import("./src/services/inboundGuard.service.ts");
    const assert = (await import("node:assert/strict")).default;
    for (const [type, mediaType] of [["audio","audio/mpeg"],["image","image/jpeg"],["document","application/pdf"]]) {
      assert.equal(guard.extractInboundMedia({type,hasMedia:true,mediaType,fileLength:2048}).valid,true);
      assert.equal(guard.extractInboundMedia({type,hasMedia:true,mediaType,fileLength:2049}).reason,"media_too_large");
    }
    assert.equal(guard.MAX_AUDIO_BYTES,2048);
  `;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: {...process.env, MAX_MEDIA_BYTES: "2048"}, encoding: "utf8",
  });
  assert.equal(child.status, 0, "fresh-module resource assertion failed");
});

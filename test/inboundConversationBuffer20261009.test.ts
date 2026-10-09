import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createClient } from "redis";
import { createInboundWebhookJob, createRedisInboundWebhookStore, createInboundWebhookQueue } from "../src/services/inboundWebhookQueue.service.js";
import { inboundAudioBufferDelayMs } from "../src/services/inboundGuard.service.js";

test("voice bursts receive a configurable settle window without phrase matching", () => {
  assert.ok(inboundAudioBufferDelayMs() >= 5000);
});

test("actual Redis conversational trailing window and ordered event boundaries", { skip: !process.env.AUDIT_REDIS_URL }, async t => {
  const client = createClient({ url: process.env.AUDIT_REDIS_URL });
  client.on("error", () => {}); await client.connect();
  const prefix = "audit_baf1_" + crypto.randomBytes(6).toString("hex");
  const store = createRedisInboundWebhookStore(client as any, async () => { assert.ok(client.isReady); }, prefix);
  let now = 100000;
  const add = async (id: string, text: string, kind: "text" | "audio" | "media" = "text", delay = 1000) => {
    const body = kind === "text" ? { body: text } : { body: text, media: { type: kind === "audio" ? "audio" : "image", mimetype: kind === "audio" ? "audio/ogg" : "image/jpeg", base64: "AA==" } };
    const job = createInboundWebhookJob(body, { instance: "fixture", phone: "70000000001", messageId: id, text, hasMedia: kind !== "text", mediaKind: kind === "audio" ? "audio" : "image", bufferMs: delay } as any, now);
    await store.put(job); return job;
  };
  const clear = async () => { const keys: string[] = []; for await (const batch of client.scanIterator({ MATCH: prefix + ":*", COUNT: 200 })) keys.push(...(Array.isArray(batch) ? batch : [batch])); if (keys.length) await client.del(keys); };
  try {
    await t.test("latest arrival extends deadline and stale due observation cannot claim early", async () => {
      const a = await add("first", "Бір сұрақ");
      const stale = (await store.due(now + 1000, 32))[0];
      now += 900; const b = await add("second", "нақтылаймын");
      assert.equal(await store.claim(stale, "early", now + 100), null);
      assert.equal((await store.due(now + 999, 32)).length, 0);
      const claimed = await store.claim(a, "owner", now + 1000);
      assert.deepEqual(claimed?.members, [a.id, b.id]);
      assert.deepEqual(claimed?.fragments, ["Бір сұрақ", "нақтылаймын"]);
      await store.finish(claimed!, "owner"); await clear();
    });
    await t.test("text audio text and another audio freeze once in arrival order", async () => {
      const a = await add("text-before", "Менің сұрағым");
      now += 200; const b = await add("voice", "[Audio sent]", "audio");
      now += 200; const c = await add("text-after", "осы туралы");
      now += 200; const d = await add("voice-two", "[Audio sent]", "audio");
      let calls = 0;
      const queue = createInboundWebhookQueue({ store, now: () => now + 1000, process: async (_body, _start, durable) => {
        calls++; assert.deepEqual((durable as any).parts.map((p: any) => p.kind), ["text", "audio", "text", "audio"]);
        assert.deepEqual((durable as any).parts.map((p: any) => p.body.messageId), ["text-before", "voice", "text-after", "voice-two"]);
      } });
      assert.equal((await queue.drain()).processed, 1); assert.equal(calls, 1);
      for (const j of [a, b, c, d]) assert.equal(JSON.parse((await client.get(prefix + ":job:" + j.id))!).status, "processed");
      assert.equal((await queue.drain()).processed, 0); await clear();
    });
    await t.test("resolved audio transcript survives a superseded retry without another inference", async () => {
      const audio = await add("cached-voice", "[Audio sent]", "audio");
      const claimed = await store.claim(audio, "audio-owner", now + 1000); assert.ok(claimed);
      assert.equal(await store.resolvePartText(claimed!, "audio-owner", audio.id, "бес мыңға комбо бар ма"), true);
      assert.equal(await store.resolvePartText(claimed!, "audio-owner", audio.id, "x".repeat(8_001)), false);
      assert.equal(await store.resolvePartText(claimed!, "audio-owner", audio.id, "\0".repeat(3_000)), false);
      await store.retry(claimed!, "audio-owner", now + 1000);
      const again = await store.claim(audio, "audio-retry", now + 1000); assert.ok(again);
      const parts = await store.parts(again!);
      assert.equal(parts[0].resolvedText, "бес мыңға комбо бар ма");
      await store.finish(again!, "audio-retry");
      await clear();
    });
    await t.test("photo is a barrier between separate conversational bundles", async () => {
      await add("before", "сұрақ"); now += 100; await add("photo", "[Photo]", "media");
      now += 100; await add("after", "түсіндіру"); now += 100; await add("voice-after", "[Audio sent]", "audio");
      const seen: string[][] = [];
      const queue = createInboundWebhookQueue({ store, now: () => now + 1000, process: async (_body, _start, durable) => { seen.push((durable as any).parts.map((p: any) => p.body.messageId)); } });
      await queue.drain(); await queue.drain(); await queue.drain();
      assert.deepEqual(seen, [["before"], ["photo"], ["after", "voice-after"]]); await clear();
    });
    await t.test("stale draft atomically absorbs the later conversational event and survives retry", async () => {
      const a = await add("draft-root", "бірінші");
      const claimed = await store.claim(a, "draft-owner", now + 1000); assert.ok(claimed);
      now += 1200; const later = await add("draft-later", "екінші");
      assert.equal(await store.authorizeReply(claimed!, "draft-owner"), false);
      await store.retry(claimed!, "draft-owner", now + 1000);
      const again = await store.claim(a, "retry-owner", now + 1000); assert.ok(again);
      assert.deepEqual(again?.members, [a.id, later.id]);
      assert.deepEqual((await store.parts(again!)).map((part) => part.text), ["бірінші", "екінші"]);
      assert.equal(await store.authorizeReply(again!, "retry-owner"), true);
      await store.finish(again!, "retry-owner");
      assert.equal((await store.due(now + 1000, 32)).length, 0);
      await clear();
    });
    await t.test("late audio extends a superseded text root through the full trailing window", async () => {
      const start = now;
      const root = await add("text-root-before-audio", "комбо бар ма", "text", 1000);
      const firstClaim = await store.claim(root, "text-owner", start + 1000); assert.ok(firstClaim);
      now = start + 1200;
      const audioOne = await add("late-audio-one", "[Audio sent]", "audio", 6000);
      assert.equal(await store.authorizeReply(firstClaim!, "text-owner"), false);
      await store.retry(firstClaim!, "text-owner", now + 1000);
      assert.equal((await store.due(now + 5999, 32)).length, 0);
      now = start + 4000;
      const audioTwo = await add("late-audio-two", "[Audio sent]", "audio", 6000);
      assert.equal((await store.due(now + 5999, 32)).length, 0);
      const combined = await store.claim(root, "combined-owner", now + 6000); assert.ok(combined);
      assert.deepEqual(combined?.members, [root.id, audioOne.id, audioTwo.id]);
      await store.finish(combined!, "combined-owner");
      await clear();
    });
    await t.test("reply reservation stops at a media barrier and later arrivals form another turn", async () => {
      const a = await add("reply-root", "мәтін");
      const claimed = await store.claim(a, "reply-owner", now + 1000); assert.ok(claimed);
      now += 1200; const photo = await add("reply-photo", "[Photo]", "media");
      now += 100; await add("reply-after-photo", "кейінгі мәтін");
      assert.equal(await store.authorizeReply(claimed!, "reply-owner"), true);
      now += 100; const postFence = await add("reply-after-fence", "жаңа turn");
      assert.equal(await store.authorizeReply(claimed!, "reply-owner"), true);
      await store.finish(claimed!, "reply-owner");
      assert.equal((await store.due(now + 1000, 32))[0].id, photo.id);
      assert.ok(await client.get(prefix + ":job:" + postFence.id));
      await clear();
    });
    await t.test("duplicate admission never extends silence and an ordinary frozen retry excludes later work", async () => {
      const start = now;
      const a = await add("root", "бір"); now += 900; const b = await add("child", "екі");
      now += 400; assert.equal(await store.put(b), false);
      const claimed = await store.claim(a, "owner", start + 1900); assert.deepEqual(claimed?.members, [a.id, b.id]);
      now = start + 2000; const later = await add("later", "үш");
      await store.retry(claimed!, "owner", start + 12000);
      const again = await store.claim(a, "retry", start + 12000); assert.deepEqual(again?.members, [a.id, b.id]);
      await store.finish(again!, "retry");
      assert.equal((await store.due(start + 12000, 32))[0].id, later.id); await clear();
    });
  } finally { await clear(); await client.quit(); }
});

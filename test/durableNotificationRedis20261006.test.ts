import assert from "node:assert/strict";
import test from "node:test";
import {spawnSync} from "node:child_process";
import crypto from "node:crypto";
const url = process.env.AUDIT_NOTIFICATION_REDIS_URL;
test("real Redis notification ledger survives a fresh worker process and fences leases", {skip: !url}, async () => {
 process.env.REDIS_URL=url!;
 const {redisClient,connectRedis}=await import("../src/services/redis.service.js");
 const {queueDurableNotification,deliverDurableNotification,redisNotificationStore}=await import("../src/services/durableNotification.service.js");
 await connectRedis();
 const prefix=`audit_notification:${crypto.randomUUID()}`;const key=`${prefix}:record`;const index=`${prefix}:pending`;const instanceId="fixture";
 try {
  await queueDurableNotification({key,index,instanceId,now:1000,recipient:"70000000001",text:"fixture safe report",payload:{report_date:"2026-10-06"}});
  const row=await deliverDurableNotification({key,index,instanceId,now:1000,
   prepare:async()=>{throw new Error("MUST_NOT_REPREPARE");},send:async()=>{throw new Error("ECONNRESET");}});
  assert.equal(row?.status,"pending");assert.equal(row?.attempts,1);assert.equal(row?.last_error,"ECONNRESET");
  assert.equal(await redisClient.ttl(key),-1);
  assert.deepEqual(await redisNotificationStore.due(index,121000),[key]);
  const script=`
   process.env.REDIS_URL=process.env.AUDIT_NOTIFICATION_REDIS_URL;
   const {redisClient,connectRedis}=await import("./src/services/redis.service.ts");
   const {deliverDurableNotification}=await import("./src/services/durableNotification.service.ts");
   await connectRedis();let sent=0;
   const row=await deliverDurableNotification({key:process.env.AUDIT_NOTIFICATION_KEY,index:process.env.AUDIT_NOTIFICATION_INDEX,instanceId:"fixture",now:121000,
    prepare:async()=>{throw new Error("MUST_NOT_REPREPARE");},
    send:async(record,requestId)=>{if(record.text!=="fixture safe report")throw new Error("PAYLOAD_CHANGED");sent++;return true;}});
   console.log(JSON.stringify({sent,status:row.status,attempts:row.attempts,delivered_at:row.delivered_at}));
   await redisClient.quit();
  `;
  const child=spawnSync(process.execPath,["--import","tsx","--input-type","module","-e",script],
   {cwd:process.cwd(),encoding:"utf8",timeout:15000,env:{...process.env,AUDIT_NOTIFICATION_KEY:key,AUDIT_NOTIFICATION_INDEX:index}});
  assert.equal(child.status,0,child.stderr);const last=JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  assert.ok((await redisClient.ttl(key))>44*24*60*60);
  assert.equal(last.sent,1);assert.equal(last.status,"delivered");assert.equal(last.attempts,2);
  assert.deepEqual(await redisNotificationStore.due(index,999999),[]);
  let duplicate=0;await deliverDurableNotification({key,index,instanceId,now:999999,prepare:async()=>{throw new Error("MUST_NOT_REPREPARE");},send:async()=>{duplicate++;return true;}});
  assert.equal(duplicate,0);
  assert.equal(await redisNotificationStore.claim(key,"owner-first"),true);
  await redisNotificationStore.release(key,"wrong-owner");
  assert.equal(await redisNotificationStore.claim(key,"owner-second"),false);
  await redisNotificationStore.release(key,"owner-first");
  assert.equal(await redisNotificationStore.claim(key,"owner-second"),true);
  await redisNotificationStore.release(key,"owner-second");
 } finally {
  await redisClient.del([key,`${key}:lock`,index]);
  await redisClient.quit();
 }
});


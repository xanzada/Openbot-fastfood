import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createClient } from "redis";
import { spawn } from "node:child_process";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { performance } from "node:perf_hooks";
import { createInboundWebhookJob, createRedisInboundWebhookStore, createInboundWebhookQueue, inboundWebhookRetryDelay } from "../src/services/inboundWebhookQueue.service.js";

const identity = (messageId = "fixture-one", overrides: Record<string, unknown> = {}) => ({instance:"queue-fixture",phone:"70000000001",messageId,text:"донер",hasMedia:false,bufferMs:0,...overrides});
test("persisted schema excludes authentication and unknown metadata at every nesting level", () => {
  const job=createInboundWebhookJob({instance:"queue-fixture",body:"донер",token:"PRIVATE_CANARY",headers:{authorization:"PRIVATE_CANARY"},data:{text:"донер",cookie:"PRIVATE_CANARY",contact:{name:"synthetic",password:"PRIVATE_CANARY"}},apiKey:"PRIVATE_CANARY"},identity());
  assert.equal(JSON.stringify(job).includes("PRIVATE_CANARY"),false);assert.equal((job.body.data as any).contact.name,"synthetic");
});
test("sender identity, voice metadata and actual download bytes survive the persisted schema", () => {
  const body={instanceId:"queue-fixture",normalizedPhone:"70000000001",messageId:"voice",type:"ptt",hasMedia:true,media:{mimetype:"audio/ogg",seconds:6,ptt:true,base64:"T2dnUw=="},data:{addressBookKnown:false,contactName:"synthetic",key:{id:"voice",remoteJid:"70000000001@s.whatsapp.net"}}};
  const job=createInboundWebhookJob(body,identity("voice",{hasMedia:true}));assert.deepEqual({...job.body.media as any},body.media);assert.equal((job.body.data as any).addressBookKnown,false);assert.equal(job.kind,"media");
});
test("id-less replay receives the same durable scope, distinct message IDs remain distinct", () => {
  const a=createInboundWebhookJob({body:"донер",timestamp:1},identity(""));const b=createInboundWebhookJob({timestamp:1,body:"донер"},identity(""));
  assert.equal(a.id,b.id);assert.equal(a.body.messageId,b.body.messageId);assert.notEqual(createInboundWebhookJob({body:"донер"},identity("one")).id,createInboundWebhookJob({body:"донер"},identity("two")).id);
});
for(const [name,body] of [["root array",[]],["unsupported nested array",{message:[]}],["prototype key",JSON.parse('{"__proto__":{"polluted":true}}')],["nonfinite numeric field",{timestamp:NaN}],["userinfo media URL",{mediaUrl:"https://user:pass@fixture.invalid/media"}],["bearer media URL",{mediaUrl:"https://fixture.invalid/media?token=PRIVATE_CANARY"}] ] as const) {
  test("bounded schema rejects "+name,()=>assert.throws(()=>createInboundWebhookJob(body,identity()),/BAD_INBOUND_EVENT/));
}
test("bounded schema rejects excessive depth without mutating the request", () => {
  let body:any={text:"x"};for(let i=0;i<18;i++)body={message:body};assert.throws(()=>createInboundWebhookJob(body,identity()),/BAD_INBOUND_EVENT/);assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype,"polluted"),false);
});
test("oversized functional media receives a retry-visible rejection",()=>assert.throws(()=>createInboundWebhookJob({base64:"x".repeat(16*1024*1024+1)},identity("media",{hasMedia:true})),/INBOUND_EVENT_TOO_LARGE/));
test("retry waits beyond the legacy text duplicate window and never abandons the job",()=>{assert.equal(inboundWebhookRetryDelay(1),10000);assert.equal(inboundWebhookRetryDelay(2),20000);assert.equal(inboundWebhookRetryDelay(999),300000);});

test("actual Redis durable inbound lane, bundle, retry and cold recovery", {skip:process.env.AUDIT_REDIS_INTEGRATION!=="1"},async t=>{
 const client=createClient({url:process.env.REDIS_URL,disableOfflineQueue:true});client.on("error",()=>{});await client.connect();
 const prefix="audit_inbound_queue_"+crypto.randomBytes(6).toString("hex");const ensure=async()=>{if(!client.isReady)throw new Error("fixture disconnected");};
 const store=createRedisInboundWebhookStore(client as any,ensure,prefix);let now=100000;
 const lane=(instance="queue-fixture",phone="70000000001")=>`${prefix}:lane:${crypto.createHash("sha256").update(JSON.stringify([instance,phone])).digest("hex")}`;
 const saved=(id:string)=>client.get(`${prefix}:job:${id}`).then(s=>JSON.parse(s!));
 const enqueue=async(id:string,overrides:Record<string,unknown>={})=>{const item=identity(id,overrides);const job=createInboundWebhookJob({body:item.text,messageId:id},item,now);await store.put(job);return job;};
 async function clearOwned(){const keys:string[]=[];for await(const batch of client.scanIterator({MATCH:prefix+":*",COUNT:200})){for(const k of Array.isArray(batch)?batch:[batch])keys.push(k);}if(keys.length)await client.del(keys);}
 try {
  await t.test("persistence and both durable indexes exist before accepted receipt",async()=>{
   const queue=createInboundWebhookQueue({store,now:()=>now,process:async()=>{throw new Error("must not process during enqueue");}});const result=await queue.enqueue({body:"донер",token:"PRIVATE_CANARY"},identity());
   assert.equal(result.inserted,true);assert.equal((await saved(result.id)).body.body,"донер");assert.equal((await saved(result.id)).body.token,undefined);assert.notEqual(await client.zScore(prefix+":due",result.id),null);assert.equal(await client.zCard(lane()),1);await clearOwned();
  });
  await t.test("rapid text fragments share one persisted bundle and first request scope",async()=>{
   const a=await enqueue("fragment-one",{text:"донер"});const b=await enqueue("fragment-two",{text:"2"});let calls=0;
   const queue=createInboundWebhookQueue({store,now:()=>now,process:async(body,_started,durable)=>{calls++;assert.equal(body.messageId,"fragment-one");assert.deepEqual(durable.fragments,["донер","2"]);assert.equal((await saved(b.id)).rootId,a.id);}});
   assert.equal((await queue.drain()).processed,1);assert.equal(calls,1);assert.equal((await saved(a.id)).status,"processed");assert.equal((await saved(b.id)).status,"processed");assert.equal(await client.zCard(lane()),0);assert.equal(await client.get(prefix+":bytes"),"0");await clearOwned();
  });
  await t.test("a frozen bundle survives retry unchanged and excludes later arrivals",async()=>{
   const a=await enqueue("frozen-one",{text:"донер"});const b=await enqueue("frozen-two",{text:"2"});const claim=await store.claim((await store.due(now,32))[0],"first-owner",now);assert.ok(claim);assert.deepEqual(claim.members,[a.id,b.id]);
   const c=await enqueue("later",{text:"кола"});await store.retry(claim,"first-owner",now+10000);now+=10000;
   const again=await store.claim((await store.due(now,32))[0],"second-owner",now);assert.ok(again);assert.deepEqual(again.members,[a.id,b.id]);assert.deepEqual(again.fragments,["донер","2"]);assert.equal(again.attempts,1);await store.finish(again,"second-owner");
   assert.equal((await saved(c.id)).status,undefined);assert.equal((await store.due(now,32))[0].id,c.id);await clearOwned();
  });
  await t.test("handler failure and busy results remain pending, then complete once after a safe retry",async()=>{
   const a=await enqueue("busy");let calls=0;const queue=createInboundWebhookQueue({store,now:()=>now,process:async()=>{calls++;if(calls===1)throw new Error("INBOUND_PROCESSING_PENDING PRIVATE_CANARY");}});
   assert.equal((await queue.drain()).processed,0);assert.equal((await saved(a.id)).attempts,1);assert.equal((await saved(a.id)).status,undefined);assert.equal((await queue.drain()).processed,0);now+=10000;
   assert.equal((await queue.drain()).processed,1);assert.equal(calls,2);assert.equal(await store.put(a),false);assert.equal((await queue.drain()).processed,0);assert.equal(JSON.stringify(await saved(a.id)).includes("PRIVATE_CANARY"),false);await clearOwned();
  });
  await t.test("renewal and completion require the actual lease owner",async()=>{
   const a=await enqueue("lease");const claim=await store.claim((await store.due(now,32))[0],"real-owner",now);assert.ok(claim);assert.equal(await store.claim(a,"other-owner",now),null);
   const ttl=await client.pTTL(lane()+":lease");assert.ok(ttl>19000&&ttl<=20000);await assert.rejects(store.renew(claim,"other-owner"),/INBOUND_LEASE_LOST/);await assert.rejects(store.finish(claim,"other-owner"),/INBOUND_LEASE_LOST/);
   await client.pExpire(lane()+":lease",5000);await store.renew(claim,"real-owner");assert.ok(await client.pTTL(lane()+":lease")>19000);await store.finish(claim,"real-owner");await clearOwned();
  });
  await t.test("expired lease permits fresh ownership, stale owner cannot remove work",async()=>{
   const a=await enqueue("expired");const claim=await store.claim((await store.due(now,32))[0],"old-owner",now);assert.ok(claim);await client.pExpire(lane()+":lease",1);await new Promise(r=>setTimeout(r,10));
   const fresh=await store.claim(a,"new-owner",now);assert.ok(fresh);await assert.rejects(store.retry(claim,"old-owner",now),/INBOUND_LEASE_LOST/);assert.equal((await saved(a.id)).status,undefined);await store.finish(fresh,"new-owner");await clearOwned();
  });
  await t.test("media separates text bundles and preserves lane order",async()=>{
   const a=await enqueue("text-before",{text:"донер"});const b=await enqueue("voice-middle",{text:"[Audio sent]",hasMedia:true});const c=await enqueue("text-after",{text:"кола"});const calls:any[]=[];
   const queue=createInboundWebhookQueue({store,now:()=>now,process:async(body,_start,durable)=>{calls.push([body.messageId,durable.fragments]);}});await queue.drain();await queue.drain();await queue.drain();
   assert.deepEqual(calls,[["text-before",["донер"]],["voice-middle",["[Audio sent]"]],["text-after",["кола"]]]);for(const j of [a,b,c])assert.equal((await saved(j.id)).status,"processed");await clearOwned();
  });
  await t.test("tenant and customer lanes remain separate",async()=>{
   await enqueue("tenant-a");await enqueue("tenant-b",{instance:"other-fixture"});await enqueue("other-phone",{phone:"70000000002"});let calls=0;
   const queue=createInboundWebhookQueue({store,now:()=>now,process:async(_body,_started,durable)=>{calls++;assert.equal(durable.fragments.length,1);}});assert.equal((await queue.drain()).processed,3);assert.equal(calls,3);await clearOwned();
  });
  await t.test("a failed lane cannot starve other customers",async()=>{
   await enqueue("blocked");for(let i=0;i<40;i++)await enqueue("behind-"+i);const other=await enqueue("healthy",{phone:"70000000002"});
   const queue=createInboundWebhookQueue({store,now:()=>now,process:async(body)=>{if(body.messageId!=="healthy")throw new Error("fixture failure");}});assert.equal((await queue.drain()).processed,1);assert.equal((await saved(other.id)).status,"processed");await clearOwned();
  });
  await t.test("capacity rejection retains old pending work without an accepted new job",async()=>{
   for(let i=0;i<64;i++)await enqueue("cap-"+i);await assert.rejects(enqueue("cap-excess"),/INBOUND_QUEUE_CAPACITY/);assert.equal(await client.zCard(lane()),64);assert.equal(await client.get(prefix+":count"),"64");await clearOwned();
  });
  await t.test("storage schema failure rejects admission and does not create volatile work",async()=>{
   await client.set(prefix+":due","synthetic-wrongtype");await assert.rejects(enqueue("storage-fail"),/INBOUND_STORAGE_TYPE/);assert.equal(await client.get(prefix+":count"),null);await clearOwned();
  });
  await t.test("corrupt pending record is retained privately, quarantined, and next lane advances",async()=>{
   const a=await enqueue("corrupt");const b=await enqueue("after-corrupt");const bad=await saved(a.id);bad.attempts=-1;await client.set(prefix+":job:"+a.id,JSON.stringify(bad));
   assert.deepEqual(await store.due(now,32),[]);assert.notEqual(await client.get(prefix+":job:"+a.id),null);assert.notEqual(await client.zScore(prefix+":quarantine",a.id),null);assert.equal((await store.due(now,32))[0].id,b.id);await clearOwned();
  });
  await t.test("actual callback waits for actual Redis persistence with a measured fixture ACK distribution",async()=>{
   const raw=fs.readFileSync(new URL("../src/routes/whatsappWebhook.route.ts",import.meta.url),"utf8");const source=ts.transpileModule(raw.slice(raw.indexOf("export function whatsappWebhookRoute()")),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
   const queue=createInboundWebhookQueue({store,now:()=>now,process:async()=>{throw new Error("fixture must never process customers");}});let callback:any;
   const env:any={exports:{},Date,console:{info(){},log(){},warn(){},error(){}},createRouter:()=>({post:(...args:any[])=>{callback=args.at(-1);}}),resolveTenantInstance:()=>{},verifySecret:()=>{},
    isOwnWhatsAppMessage:()=>false,getInstanceId:(b:any)=>b.instanceId,getPhone:(b:any)=>b.phone,maskPhone:()=>"masked",extractMessageId:(b:any)=>b.messageId,extractInboundText:(b:any)=>b.body,extractInboundMedia:()=>null,
    DEVELOPER_ALERT_MARKER_RE:/__never_in_fixture__/,inboundBufferDelayMs:()=>500,startInboundWebhookQueueWorker:()=>{},processWhatsAppWebhook:()=>{},enqueueVerifiedInboundWebhook:(body:any,identity:any)=>queue.enqueue(body,identity)};
   vm.runInNewContext(source+";exports.whatsappWebhookRoute();",env);const samples:number[]=[];
   for(let i=0;i<25;i++){
    let status=0;const res:any={status(n:number){status=n;return this;},json(body:any){return{status,body};}};const started=performance.now();const result=await callback({body:{instanceId:"queue-fixture",phone:"70000000001",messageId:"latency-"+i,body:"донер"}},res);const elapsed=performance.now()-started;
    assert.equal(result.status,202);assert.equal(result.body.accepted,true);assert.equal((await saved(result.body.job_id)).body.messageId,"latency-"+i);if(i>=5)samples.push(elapsed);
   }
   samples.sort((a,b)=>a-b);console.log("INBOUND_CALLBACK_ACK_RECEIPT "+JSON.stringify({samples:20,warmup:5,p50ms:samples[9],p95ms:samples[18],maxMs:samples[19],actualRedis:true,actualCallback:true,authMiddlewareExecuted:false,callerHttpAndCustomerTransportMeasured:false,realCustomerSends:0,realProviderCalls:0}));await clearOwned();
  });
  await t.test("actual child crash after durable bundle claim recovers after the real lease expiry",async()=>{
   const common=`import crypto from 'node:crypto';import {createClient} from 'redis';import {createRedisInboundWebhookStore,createInboundWebhookQueue} from './src/services/inboundWebhookQueue.service.ts';const c=createClient({url:process.env.REDIS_URL});c.on('error',()=>{});await c.connect();const s=createRedisInboundWebhookStore(c,async()=>{},process.env.FIXTURE_PREFIX);let count=0;const q=createInboundWebhookQueue({store:s,now:()=>Number(process.env.FIXTURE_NOW),process:async(b,_t,d)=>{if(b.messageId!=='cold-one'||d.fragments.join('|')!=='донер|2')throw Error('cold identity mismatch');count++;}});`;
   async function child(script:string){const p=spawn(process.execPath,["--import","tsx","--input-type","module","-e",common+script],{cwd:process.cwd(),env:{...process.env,FIXTURE_PREFIX:prefix,FIXTURE_NOW:String(now)},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";p.stdout.on("data",d=>{stdout+=d});p.stderr.on("data",d=>{stderr+=d});const exit=await new Promise(r=>p.once("exit",r));return{exit,stdout,stderr};}
   const crashed=await child(`const i={instance:'queue-fixture',phone:'70000000001',messageId:'cold-one',text:'донер',hasMedia:false,bufferMs:0};const a=await q.enqueue({body:'донер'},i);const b=await q.enqueue({body:'2'},{...i,messageId:'cold-two',text:'2'});const j=await s.claim((await s.due(Number(process.env.FIXTURE_NOW),32))[0],'crashed-owner',Number(process.env.FIXTURE_NOW));if(j.members.length!==2)throw Error('bundle not frozen');const lk=process.env.FIXTURE_PREFIX+':lane:'+crypto.createHash('sha256').update(JSON.stringify([i.instance,i.phone])).digest('hex')+':lease';console.log(JSON.stringify({phase:'before_crash',ids:[a.id,b.id],leaseMs:await c.pTTL(lk),processed:count}));process.exit(77);`);
   assert.equal(crashed.exit,77,crashed.stderr);const receipt=JSON.parse(crashed.stdout.trim());assert.equal(receipt.processed,0);assert.ok(receipt.leaseMs>19000&&receipt.leaseMs<=20000);assert.equal((await saved(receipt.ids[1])).rootId,receipt.ids[0]);
   await new Promise(r=>setTimeout(r,21000));
   const recovered=await child(`const result=await q.drain();console.log(JSON.stringify({count,processed:result.processed}));await c.quit();`);assert.equal(recovered.exit,0,recovered.stderr);assert.deepEqual(JSON.parse(recovered.stdout.trim()),{count:1,processed:1});
   for(const id of receipt.ids)assert.equal((await saved(id)).status,"processed");assert.equal(await store.put(createInboundWebhookJob({body:"донер"},identity("cold-one"),now)),false);assert.equal(await store.put(createInboundWebhookJob({body:"2"},identity("cold-two",{text:"2"}),now)),false);await clearOwned();
  });
 } finally {try{await clearOwned();}finally{await client.quit();}}
});

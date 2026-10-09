import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const filename=process.env.REV35_ROUTE_BASELINE || new URL("../src/routes/whatsappWebhook.route.ts",import.meta.url);
const raw=fs.readFileSync(filename,"utf8");
const source=ts.transpileModule(raw.slice(raw.indexOf("async function processWhatsAppWebhook("),raw.indexOf("export function whatsappWebhookRoute()")),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(reason?:string, options:{lockAvailable?:boolean; media?:boolean; preloadError?:string}={}){
 let done=0,cleared=0,bufferCalls=0,merged:string[]=[];const events:string[]=[];const env:any={exports:{},Date,console:{log(){},warn(){},error(){}},setTimeout:(fn:()=>void)=>{fn();return 0;},
 getInstanceId:(b:any)=>b.instance,getPhone:(b:any)=>b.phone,extractMessageId:(b:any)=>b.messageId,extractInboundMedia:()=>options.media?{kind:"audio",historyLabel:"[Audio sent]"}:null,extractSenderMeta:()=>({}),extractInboundText:(b:any)=>b.body,
 maskPhone:()=>"masked",isTenantBotEnabled:async()=>true,guardIncomingMessage:async()=>({blocked:!!reason,reason,dedupeId:"synthetic-id"}),
 isOwnWhatsAppMessage:()=>false,isGroupMessage:()=>false,startWhatsProTyping:()=>()=>{},markWhatsProChatRead:()=>{},
 bufferInboundText:async()=>{bufferCalls++;return{leader:false};},markInboundDone:async()=>{done++;},acquireTurnLock:async()=>{events.push("acquire");return options.lockAvailable===false?null:"synthetic-turn-owner";},releaseTurnLock:async()=>{events.push("release");},
 drainInboundBuffer:async()=>[],mergePartsDeterministic:(parts:string[])=>{events.push("merge");merged=parts;return parts.join(" ");},mergeBufferedParts:async(parts:string[])=>parts.join(" "),hydrateInboundMedia:async()=>{events.push("hydrate");return null;},preloadContext:async()=>{events.push("preload");throw new Error(options.preloadError||"SYNTHETIC_BEFORE_CUSTOMER_DELIVERY");},
 clearInboundProcessing:async()=>{cleared++;},notifyDeveloperSystemFailure:async()=>{},saveToHistory:async()=>{},
 };
 vm.runInNewContext(source+";exports.process=processWhatsAppWebhook;",env);
 return{process:env.exports.process,state:()=>({done,cleared,bufferCalls,merged,events})};
}
const body={instance:"audit-processing",phone:"70000000001",messageId:"synthetic-id",body:"донер"};
test("accepted durable fragments cannot become done in a volatile follower before customer delivery",async()=>{
 const f=fixture();await assert.rejects(f.process(body,Date.now(),{fragments:["донер","2"],attempts:0}),/SYNTHETIC_BEFORE_CUSTOMER_DELIVERY/);
 assert.equal(f.state().done,0);assert.equal(f.state().bufferCalls,0);assert.equal(JSON.stringify(f.state().merged),JSON.stringify(["донер","2"]));assert.equal(f.state().cleared,1);
});
test("superseded durable reply clears only its owned processing guard before fast retry",async()=>{
 const f=fixture(undefined,{preloadError:"INBOUND_REPLY_SUPERSEDED"});
 await assert.rejects(f.process(body,Date.now(),{fragments:["донер"],parts:[],attempts:0}),/INBOUND_REPLY_SUPERSEDED/);
 assert.equal(f.state().done,0);assert.equal(f.state().cleared,1);
});
for(const reason of ["duplicate_processing","duplicate_processing_local"]){
 test("busy "+reason+" retains durable work without clearing the other owner",async()=>{
  const f=fixture(reason);await assert.rejects(f.process(body,Date.now(),{fragments:["донер"],attempts:1}),/INBOUND_PROCESSING_PENDING/);assert.equal(f.state().done,0);assert.equal(f.state().cleared,0);
 });
}
test("completed duplicate is a terminal outcome, distinct from busy",async()=>{
 const f=fixture("duplicate_done");await f.process(body,Date.now(),{fragments:["донер"],attempts:1});assert.equal(f.state().done,0);assert.equal(f.state().cleared,0);
});
test("durable fragment merge and context hydration require the shared turn lock first",async()=>{
 const f=fixture();await assert.rejects(f.process(body,Date.now(),{fragments:["донер","2"],attempts:0}),/SYNTHETIC_BEFORE_CUSTOMER_DELIVERY/);
 assert.deepEqual(f.state().events,["acquire","merge","hydrate","preload","release"]);assert.equal(f.state().done,0);assert.equal(f.state().bufferCalls,0);
});
for(const media of [false,true]){
 test("durable "+(media?"media":"text bundle")+" remains retryable when the turn lock stays busy",async()=>{
  const f=fixture(undefined,{lockAvailable:false,media});await assert.rejects(f.process(body,Date.now(),{fragments:["донер","2"],attempts:1}),/INBOUND_TURN_PENDING/);
  assert.equal(f.state().done,0);assert.equal(f.state().bufferCalls,0);assert.equal(f.state().cleared,1);assert.equal(f.state().events.includes("merge"),false);assert.equal(f.state().events.includes("hydrate"),false);assert.equal(f.state().events.includes("preload"),false);assert.equal(f.state().events.includes("release"),false);
 });
}

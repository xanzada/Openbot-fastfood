import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

const filename=process.env.REV35_ROUTE_BASELINE || new URL("../src/routes/whatsappWebhook.route.ts",import.meta.url);
const raw=fs.readFileSync(filename,"utf8");
const source=ts.transpileModule(raw.slice(raw.indexOf("async function processWhatsAppWebhook("),raw.indexOf("export function whatsappWebhookRoute()")),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
function fixture(reason?:string){
 let done=0,cleared=0,bufferCalls=0,merged:string[]=[];const env:any={exports:{},Date,console:{log(){},warn(){},error(){}},
 getInstanceId:(b:any)=>b.instance,getPhone:(b:any)=>b.phone,extractMessageId:(b:any)=>b.messageId,extractInboundMedia:()=>null,extractSenderMeta:()=>({}),extractInboundText:(b:any)=>b.body,
 maskPhone:()=>"masked",isTenantBotEnabled:async()=>true,guardIncomingMessage:async()=>({blocked:!!reason,reason,dedupeId:"synthetic-id"}),
 isOwnWhatsAppMessage:()=>false,isGroupMessage:()=>false,startWhatsProTyping:()=>()=>{},markWhatsProChatRead:()=>{},
 bufferInboundText:async()=>{bufferCalls++;return{leader:false};},markInboundDone:async()=>{done++;},acquireTurnLock:async()=>"synthetic-turn-owner",releaseTurnLock:async()=>{},
 mergeBufferedParts:async(parts:string[])=>{merged=parts;return parts.join(" ");},hydrateInboundMedia:async()=>null,preloadContext:async()=>{throw new Error("SYNTHETIC_BEFORE_CUSTOMER_DELIVERY");},
 clearInboundProcessing:async()=>{cleared++;},notifyDeveloperSystemFailure:async()=>{},saveToHistory:async()=>{},
 };
 vm.runInNewContext(source+";exports.process=processWhatsAppWebhook;",env);
 return{process:env.exports.process,state:()=>({done,cleared,bufferCalls,merged})};
}
const body={instance:"audit-processing",phone:"70000000001",messageId:"synthetic-id",body:"донер"};
test("accepted durable fragments cannot become done in a volatile follower before customer delivery",async()=>{
 const f=fixture();await assert.rejects(f.process(body,Date.now(),{fragments:["донер","2"],attempts:0}),/SYNTHETIC_BEFORE_CUSTOMER_DELIVERY/);
 assert.equal(f.state().done,0);assert.equal(f.state().bufferCalls,0);assert.deepEqual(f.state().merged,["донер","2"]);assert.equal(f.state().cleared,1);
});
for(const reason of ["duplicate_processing","duplicate_processing_local"]){
 test("busy "+reason+" retains durable work without clearing the other owner",async()=>{
  const f=fixture(reason);await assert.rejects(f.process(body,Date.now(),{fragments:["донер"],attempts:1}),/INBOUND_PROCESSING_PENDING/);assert.equal(f.state().done,0);assert.equal(f.state().cleared,0);
 });
}
test("completed duplicate is a terminal outcome, distinct from busy",async()=>{
 const f=fixture("duplicate_done");await f.process(body,Date.now(),{fragments:["донер"],attempts:1});assert.equal(f.state().done,0);assert.equal(f.state().cleared,0);
});

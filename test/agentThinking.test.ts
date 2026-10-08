import test from "node:test";
import assert from "node:assert/strict";
import { shouldThink } from "../src/services/agentThinking.service.js";

function ctx(text: string, mediaContext: any = null) {
  return { text, mediaContext } as any;
}

test("trivial turns never pay for a think call", () => {
  for (const text of [
    "Сәлем",
    "привет",
    "рахмет!",
    "спасибо",
    "жарайды",
    "ок",
    "иә",
    "да",
    "қош",
    "👍",
  ]) {
    assert.equal(shouldThink(ctx(text)), false, text);
  }
});

test("money, orders and complaints always earn the pre-pass", () => {
  for (const text of [
    "заказ келмеді, не істейін?",
    "мой заказ опаздывает уже час",
    "төлемді төледім, чек жібердім",
    "я оплатил, куда чек отправить",
    "шағымым бар, тамақ суық келді",
    "хочу вернуть деньги за заказ",
    "оператор шақырыңызшы",
  ]) {
    assert.equal(shouldThink(ctx(text)), true, text);
  }
});

test("long or multi-question turns are thought-worthy", () => {
  assert.equal(shouldThink(ctx("Пицца бар ма, канша турады, жеткизу қанша уақыт алады?")), true);
  assert.equal(
    shouldThink(ctx("Кешіріңіз, кеше тапсырыс берген едім, бүгін тағы сұрайын деп едім: жинағыңыздағы пиццалардың қайсысы ең дәмді және олардың бағасы қанша болады, сондай-ақ жеткізу қанша уақытта келеді деген сұрақ та бар еді?")),
    true
  );
  assert.equal(shouldThink(ctx("Не боп болып жатыр?! Тағы да кешікті!!")), true);
});

test("one neutral question does not pay for a think call but two questions do", () => {
  assert.equal(shouldThink(ctx("Can you help?")), false);
  assert.equal(shouldThink(ctx("Can you help? What is next?")), true);
});

test("media turns get analysis because captions are rarely self-explanatory", () => {
  assert.equal(shouldThink(ctx("мынау не?", { kind: "photo" })), true);
});

test("empty text is never analysed", () => {
  assert.equal(shouldThink(ctx("")), false);
});


test("current intelligence20261008 THINK success clears deadline and preserves generator arguments",async(t)=>{
 const {generateWithTimeout}=await import("../src/services/agentThinking.service.js");
 const set=globalThis.setTimeout,clear=globalThis.clearTimeout,scheduled:any[]=[],cleared:any[]=[];
 t.mock.method(globalThis,"setTimeout",((callback:any,ms:any,...args:any[])=>{const id=set(callback,ms,...args);if(ms===37)scheduled.push(id);return id;}) as any);
 t.mock.method(globalThis,"clearTimeout",((id:any)=>{cleared.push(id);return clear(id);}) as any);
 let calls=0,signal:AbortSignal|undefined;
 const result=await generateWithTimeout({owned:true},{prompt:"fixture",temperature:0.1},37,async args=>{
  calls++;signal=args.abortSignal;assert.equal(args.prompt,"fixture");assert.equal(args.temperature,0.1);return {text:"ok"};
 });
 assert.deepEqual(result,{text:"ok"});assert.equal(calls,1);assert.ok(signal instanceof AbortSignal);assert.equal(signal?.aborted,false);
 assert.equal(scheduled.length,1);assert.ok(cleared.includes(scheduled[0]));
});
test("current intelligence20261008 THINK timeout aborts once and consumes a late rejection",async(t)=>{
 const {generateWithTimeout}=await import("../src/services/agentThinking.service.js");
 const set=globalThis.setTimeout,clear=globalThis.clearTimeout,scheduled:any[]=[],cleared:any[]=[];
 t.mock.method(globalThis,"setTimeout",((callback:any,ms:any,...args:any[])=>{const id=set(callback,ms,...args);if(ms===7)scheduled.push(id);return id;}) as any);
 t.mock.method(globalThis,"clearTimeout",((id:any)=>{cleared.push(id);return clear(id);}) as any);
 let calls=0,aborts=0,lateReject:any,signal:AbortSignal|undefined;const unhandled:any[]=[];const listener=(e:any)=>unhandled.push(e);
 process.on("unhandledRejection",listener);
 try{
  await assert.rejects(generateWithTimeout({}, {},7,args=>{calls++;signal=args.abortSignal;signal?.addEventListener("abort",()=>aborts++);return new Promise((_resolve,reject)=>{lateReject=reject;});}),/THINK_TIMEOUT:7ms/);
  assert.equal(calls,1);assert.equal(aborts,1);assert.equal(signal?.aborted,true);assert.ok(cleared.includes(scheduled[0]));
  lateReject(new Error("synthetic late rejection"));await new Promise(resolve=>set(resolve,15));assert.deepEqual(unhandled,[]);
 }finally{process.removeListener("unhandledRejection",listener);}
});
test("current intelligence20261008 THINK generator rejection clears deadline without another model call",async(t)=>{
 const {generateWithTimeout}=await import("../src/services/agentThinking.service.js");
 const set=globalThis.setTimeout,clear=globalThis.clearTimeout,scheduled:any[]=[],cleared:any[]=[];
 t.mock.method(globalThis,"setTimeout",((callback:any,ms:any,...args:any[])=>{const id=set(callback,ms,...args);if(ms===41)scheduled.push(id);return id;}) as any);
 t.mock.method(globalThis,"clearTimeout",((id:any)=>{cleared.push(id);return clear(id);}) as any);
 let calls=0;
 await assert.rejects(generateWithTimeout({}, {},41,async()=>{calls++;throw new Error("synthetic generator failure");}),/synthetic generator failure/);
 assert.equal(calls,1);assert.equal(scheduled.length,1);assert.ok(cleared.includes(scheduled[0]));
});


// Execute the actual source analysis path with only model factory/generator replaced.
// This is a deterministic exported boundary, not a paid THINK/SDK/WhatsApp run.
const tenantThinkFakeSymbol20261009=Symbol.for("owned-tenant-decision-think-fake-20261009");
async function loadTenantThinkSource20261009(){
 const fs=await import("node:fs/promises"),ts=await import("typescript");
 const url=new URL("../src/services/agentThinking.service.ts",import.meta.url);
 const source=await fs.readFile(url,"utf8");
 let js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 const factory='import { getAnalysisModel } from "./llm.service.js";';
 assert.equal(js.split(factory).length-1,1,"fake must replace only the exact model factory import");
 js=js.replace(factory,'const getAnalysisModel = () => ({ ownedFakeModel: true });');
 const generator='(await import("ai")).generateText';
 assert.equal(js.split(generator).length-1,1,"fake must trap the only dynamic generator boundary");
 js=js.replace(generator,'globalThis[Symbol.for("owned-tenant-decision-think-fake-20261009")]');
 js=js.replace(/from "(\.[^"]+)"/g,(_match,path)=>'from '+JSON.stringify(new URL(path.replace(/\.js$/,'.ts'),url).href));
 return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
}
const tenantThinkCtx20261009=(patch:any={})=>({instanceId:"owned-tenant",language:"ru",text:"Мой заказ опаздывает, почему так и что мне делать?",config:{instance_id:"owned-tenant"},chatHistory:[],activeOrder:null,activeShiftNotes:[],runtimeStatus:null,hardRealtimeContext:{},mediaContext:null,...patch} as any);
async function observedThinkingInput20261009(c:any){
 const module=await loadTenantThinkSource20261009();let calls=0,captured:any;
 (globalThis as any)[tenantThinkFakeSymbol20261009]=async(options:any)=>{calls++;captured=options;return {text:JSON.stringify({goal:"status",mood:"unsure",urgency:"normal",complexity:"moderate",risk:"high",style_hint:"verify",reasoning_brief:"needs facts",proactive_note:""})};};
 try{
  const result=await module.analyzeTurnSituation(c,{requiredTools:[]});
  assert.equal(calls,1);assert.equal(result?.goal,"status");assert.ok(captured.abortSignal instanceof AbortSignal);
  const line=captured.prompt.split("\n").find((line:string)=>line.startsWith("tenant_context: "));
  assert.ok(line,"actual THINK must receive the bounded tenant/factual context");
  return {context:JSON.parse(line.slice("tenant_context: ".length)),captured};
 }finally{delete (globalThis as any)[tenantThinkFakeSymbol20261009];}
}
test("tenant-decision actual20261009 THINK retains same tenant policy beyond600 and exact20000",async()=>{
 const policy="a".repeat(19980)+" END_OF_OWNER_POLICY";
 const {context}=await observedThinkingInput20261009(tenantThinkCtx20261009({config:{instance_id:"owned-tenant",system_prompt:policy+"OVERFLOW"}}));
 assert.equal(context.tenant_policy.text,policy);assert.equal(context.instance_id,"owned-tenant");
 assert.match(context.rule,/advisory/i);assert.match(context.rule,/recheck/i);
});
test("tenant-decision actual20261009 THINK receives allowlisted order and operational snapshot",async()=>{
 const {context}=await observedThinkingInput20261009(tenantThinkCtx20261009({activeOrder:{status:"completed",phone:"PRIVATE_ORDER_PHONE",address:"PRIVATE_ORDER_ADDRESS",payment_status:"PRIVATE_PAYMENT_PAYLOAD"},hardRealtimeContext:{runtime_available:true,stale:false,wait_time:30,delivery:true,pickup:false},activeShiftNotes:[{id:"note",text:"Донер жоқ"}]}));
 assert.equal(context.active_order.present,true);assert.equal(context.active_order.status,"completed");
 assert.equal(context.operational_snapshot.runtime_state,"available_snapshot");assert.equal(context.operational_snapshot.wait_minutes,30);
 assert.equal(context.operational_snapshot.delivery,true);assert.equal(context.operational_snapshot.pickup,false);
 assert.ok(context.operator_constraints.some((entry:any)=>entry.unavailable_now.some((term:string)=>/донер/i.test(term))));
 assert.doesNotMatch(JSON.stringify(context),/PRIVATE_ORDER|PRIVATE_PAYMENT/);
});
test("tenant-decision actual20261009 THINK missing and stale facts stay unknown",async()=>{
 for(const hardRealtimeContext of [{},{runtime_available:false,wait_time:0,delivery:true},{runtime_available:true,stale:true,wait_time:30,delivery:true}]){
  const {context}=await observedThinkingInput20261009(tenantThinkCtx20261009({hardRealtimeContext,activeOrder:{status:{private:"bad"}}}));
  assert.equal(context.operational_snapshot.runtime_state,"unknown_or_stale");assert.equal(context.operational_snapshot.wait_minutes,null);assert.equal(context.operational_snapshot.delivery,null);
  assert.equal(context.active_order.status,"unknown");assert.match(context.active_order.rule,/snapshot/i);
 }
});
test("tenant-decision actual20261009 THINK omits rawconfig secrets and customer address",async()=>{
 const {context}=await observedThinkingInput20261009(tenantThinkCtx20261009({config:{instance_id:"owned-tenant",systemPrompt:"SAME_TENANT_POLICY",api_key:"NEVER_EXPORT_KEY",alemi_secret:"NEVER_EXPORT_SECRET",address:"NEVER_EXPORT_CONFIG_ADDRESS"},senderMeta:{address:"NEVER_EXPORT_SENDER"},fetchedSettings:{secret:"NEVER_EXPORT_SETTINGS"},customerProfile:{address:"NEVER_EXPORT_PROFILE"},runtimeStatus:{secret:"NEVER_EXPORT_RUNTIME"}}));
 assert.equal(context.tenant_policy.text,"SAME_TENANT_POLICY");assert.doesNotMatch(JSON.stringify(context),/NEVER_EXPORT/);
});
test("tenant-decision actual20261009 THINK explicit foreign records cannot enter owned context",async()=>{
 const {context}=await observedThinkingInput20261009(tenantThinkCtx20261009({config:{instance_id:"other-tenant",system_prompt:"FOREIGN_POLICY"},activeOrder:{instance_id:"other-tenant",status:"completed"},hardRealtimeContext:{instance_id:"other-tenant",runtime_available:true,wait_time:10},activeShiftNotes:[{instanceId:"other-tenant",id:"foreign-note",text:"Фри жоқ"}]}));
 assert.equal(context.tenant_policy,null);assert.equal(context.active_order.present,false);assert.equal(context.active_order.status,"unknown");assert.equal(context.operational_snapshot.runtime_state,"unknown_or_stale");assert.deepEqual(context.operator_constraints,[]);assert.doesNotMatch(JSON.stringify(context),/FOREIGN_POLICY/);
});
test("tenant-decision actual20261009 THINK keeps trivial gate and no extra fake call",async()=>{
 const module=await loadTenantThinkSource20261009();let calls=0;(globalThis as any)[tenantThinkFakeSymbol20261009]=async()=>{calls++;throw new Error("must not generate");};
 try{assert.equal(await module.analyzeTurnSituation(tenantThinkCtx20261009({text:"спасибо"}),{requiredTools:[]}),null);assert.equal(calls,0);}
 finally{delete (globalThis as any)[tenantThinkFakeSymbol20261009];}
});

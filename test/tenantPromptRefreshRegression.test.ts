import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";
import {buildFactsPrompt} from "../src/context/buildFactsPrompt.js";
import { mergeShiftNoteSources } from "../src/services/noteProvenance.service.js";
function load(relative:string,modules:Record<string,unknown>,extra:Record<string,unknown>={}){
 const raw=fs.readFileSync(new URL("../src/"+relative,import.meta.url),"utf8");
 const compiled=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 const exports:any={};vm.runInNewContext(compiled,{exports,require:(name:string)=>{if(!(name in modules))throw Error("UNEXPECTED_FAKE_DEPENDENCY:"+name);return modules[name];},console:{info(){},log(){},warn(){},error(){}},process:{env:{}},Date,Set,Map,Promise,...extra});return exports;
}
function configFixture(){
 let now=Date.now(),calls=0,fail=false,latest:any={instance_id:"alpha",prompt_mode:"custom",system_prompt:"OLD_CUSTOM_SENTINEL",bot_enabled:true,updated_at:"v1"};
 const cache=new Map<string,{value:any;until:number}>();
 class Clock extends Date{constructor(value?:any){super(value===undefined?now:value);}static now(){return now;}}
 const modules:any={
  axios:{__esModule:true,default:{get:async(url:string)=>{calls++;assert.match(url,/\/api\/wa\/runtime-configs\/alpha$/);if(fail)throw Error("SYNTHETIC_OUTAGE");return{data:{config:structuredClone(latest)}};}}},
  ai:{},zod:{z:{}},
  "./redis.service.js":{getJsonCache:async(k:string)=>{const row=cache.get(k);return row&&row.until>now?structuredClone(row.value):null;},setJsonCache:async(k:string,ttl:number,value:any)=>{cache.set(k,{value:structuredClone(value),until:now+ttl*1000});},deleteCache:async(k:string)=>cache.delete(k)},
  "./llm.service.js":{},"./llmWorkspace.service.js":{getRuntimeSettings:()=>({})},"../utils/envNumber.js":{envNumber:(_v:any,fallback:number)=>fallback}
 };
 const platform=load("services/platformConfig.service.ts",modules,{Date:Clock,process:{env:{TENANTS_PLATFORM_BASE_URL:"https://fixture.invalid",TENANTS_PLATFORM_API_TOKEN:"SYNTHETIC_NON_SECRET"}}});
 return{platform,cache,advance:(ms:number)=>{now+=ms;},set:(v:any)=>{latest=v;},outage:()=>{fail=true;},calls:()=>calls};
}
function preload(platform:any,overrides:Record<string,unknown>={}){
 const empty=async()=>null,list=async()=>[];
 const modules:any={
  "node:crypto":crypto,"../utils/envNumber.js":{envNumber:(_v:any,fallback:number)=>fallback},
  "../utils/language.js":{detectLanguageDecision:async()=>({language:"ru",lockable:true,confidence:1}),isLanguageBearingCustomerText:()=>false,lastCustomerLanguage:()=>null,lastResolvedCustomerLanguage:()=>null},
  "../utils/magicLink.js":{hasBrokenLinkReport:()=>false,hasExplicitMenuLinkIntent:()=>false,isContextualLinkResendRequest:()=>false,normalizeMenuDomain:()=>""},
  "../services/dle.service.js":{normalizePhone:(x:string)=>x.replace(/\D/g,""),getRuntimeStatus:empty,getOrderStatus:empty,getMenuContext:empty},
  "../services/alemiApi.service.js":{issueCustomerAccessLink:async()=>{throw Error("CUSTOMER_EFFECT_FORBIDDEN");},upsertCustomerLead:async()=>{throw Error("CUSTOMER_EFFECT_FORBIDDEN");}},
  "../services/platformConfig.service.js":{getRestaurantConfig:platform.getRestaurantConfig,getShporContext:list},
  "../services/redis.service.js":{connectRedis:async()=>true,getUserLang:empty,getSiteLanguageHint:empty,getChatHistory:list,getActiveShiftNotes:list,getMagicLinkSentAt:async()=>0,getDeletedShiftNoteIds:async()=>new Set(),withoutDeletedNotes:(x:any)=>x,replaceUserLang:empty,saveUserLang:empty},
  "../services/customerMemory.service.js":{getCustomerProfile:empty,getConversationSummary:empty,getTurnTrace:empty},
  "../services/goalTracker.service.js":{getActiveGoal:empty},
  "../services/customerOrder.service.js":{orderMentionedByItems:()=>null,pickConversationOrder:()=>null},
  "../services/noteProvenance.service.js":{matchingNoteIds:()=>[],mergeShiftNoteSources:()=>[]},
  "../utils/orderIntent.js":{hasDirectOrderIntent:()=>false,lastDiscussedOrderNumber:()=>null},
  "../services/complaintRouting.service.js":{isLikelyComplaintText:()=>false,isLikelyOperatorRequestText:()=>false},
  "../utils/linkRecency.js":{isMagicLinkRecent:()=>false},
  "../services/languagePolicy.service.js":{resolvePriorConversationLanguage:()=>({language:null,source:"none"}),resolveOrganicLanguage:()=>({language:"ru",source:"fallback"}),shouldSwitchLockedLanguage:()=>false,textCarriesDecisiveLanguageSignal:()=>false,unclassifiedTextIsDecisive:()=>false,instantLanguageDecision:()=>null},
  "../services/workHours.service.js":{evaluateWorkHours:()=>({configured:false,withinWorkHours:true})}
 };return load("context/preloadContext.ts",{...modules,...overrides}).preloadContext;
}
const incoming={instanceId:"alpha",phone:"77000000001",text:"ок"};
const readFacts=(ctx:any)=>JSON.parse(buildFactsPrompt(ctx).split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
test("authoritative empty prompt survives warm normal-control refresh and actual context preload",async()=>{
 const f=configFixture(),hydrate=preload(f.platform);assert.equal((await hydrate(incoming)).config.system_prompt,"OLD_CUSTOM_SENTINEL");assert.equal(f.calls(),1);
 f.set({instance_id:"alpha",prompt_mode:"shared",system_prompt:"",bot_enabled:true,updated_at:"v2"});
 assert.equal((await hydrate(incoming)).config.system_prompt,"OLD_CUSTOM_SENTINEL"); // Direct warm getter is not an invalidation.
 await f.platform.isTenantBotEnabled("alpha");let c=await hydrate(incoming);assert.equal(c.config.system_prompt,"");assert.equal(c.config.prompt_mode,"shared");assert.equal(c.config.updated_at,"v2");assert.ok(!JSON.stringify(readFacts(c)).includes("OLD_CUSTOM_SENTINEL"));
 f.set({instance_id:"alpha",prompt_mode:"custom",system_prompt:"NEW_CUSTOM_SENTINEL",bot_enabled:true,updated_at:"v3"});
 await f.platform.isTenantBotEnabled("alpha");assert.equal((await hydrate(incoming)).config.system_prompt,""); //2s control cache.
 f.advance(2001);await f.platform.isTenantBotEnabled("alpha");c=await hydrate(incoming);assert.equal(c.config.system_prompt,"NEW_CUSTOM_SENTINEL");
 f.advance(2001);f.set({instance_id:"alpha",prompt_mode:"custom",system_prompt:"",bot_enabled:true,updated_at:"v4"});await f.platform.isTenantBotEnabled("alpha");assert.equal((await hydrate(incoming)).config.system_prompt,"");
});
test("forced refresh clears old custom while ordinary direct warm getter stays explicitly cached",async()=>{
 const f=configFixture();assert.equal((await f.platform.getRestaurantConfig("alpha")).system_prompt,"OLD_CUSTOM_SENTINEL");
 f.set({instance_id:"alpha",prompt_mode:"shared",system_prompt:"",bot_enabled:true,updated_at:"v2"});
 assert.equal((await f.platform.getRestaurantConfig("alpha")).system_prompt,"OLD_CUSTOM_SENTINEL");
 assert.equal((await f.platform.refreshRestaurantConfig("alpha")).system_prompt,"");assert.equal((await f.platform.getRestaurantConfig("alpha")).system_prompt,"");assert.equal(f.calls(),2);
});
test("unavailable config preserves known backup but authoritative forced path refuses stale recovery",async()=>{
 const f=configFixture();await f.platform.getRestaurantConfig("alpha");f.outage();f.advance(301000);
 assert.equal((await f.platform.getRestaurantConfig("alpha")).system_prompt,"OLD_CUSTOM_SENTINEL");
 assert.equal(await f.platform.refreshRestaurantConfig("alpha"),null); // Stale tolerance is qualified, never advertised as a fresh policy.
});
test("wrong-tenant response cannot overwrite a known explicitly empty prompt",async()=>{
 const f=configFixture();f.set({instance_id:"alpha",system_prompt:"",prompt_mode:"shared"});await f.platform.getRestaurantConfig("alpha");
 f.set({instance_id:"beta",system_prompt:"FOREIGN_POLICY"});assert.equal(await f.platform.refreshRestaurantConfig("alpha"),null);assert.equal((await f.platform.getRestaurantConfig("alpha")).system_prompt,"");
});

test("each customer turn sees current operator notes before the fresh menu, including deletion and price changes",async()=>{
 const events:string[]=[];
 let notes:any[]=[{noteId:"old",text:"Sample sold out"}],price=1000,deleted=new Set<string>();
 const hydrate=preload({getRestaurantConfig:async()=>({domain:"fixture.invalid"})},{
  "../services/dle.service.js":{
   normalizePhone:(x:string)=>x.replace(/\D/g,""),
   getOrderStatus:async()=>null,
   getRuntimeStatus:async(_id:string,_domain:string,options:any)=>{
    assert.equal(options.forceFresh,true);assert.equal(options.staleWhileRevalidateMs,undefined);
    events.push("runtime");notes=[];deleted=new Set(["old"]);
    return {runtime_available:true,source:"fixture_live",shift_notes:[],fetched_at:new Date().toISOString()};
   },
   getMenuContext:async(_id:string,_domain:string,_lang:string,options:any)=>{
    assert.equal(options.forceFresh,true);assert.deepEqual(events,["runtime","notes"]);
    events.push("menu");return {source:"fixture_live",items:[{name:"Sample",price,available:true}]};
   },
  },
  "../services/redis.service.js":{
   connectRedis:async()=>true,getUserLang:async()=>null,getSiteLanguageHint:async()=>null,
   getChatHistory:async()=>[{role:"assistant",content:"Sample sold out",sourceNoteIds:["old"]}],
   getActiveShiftNotes:async()=>{events.push("notes");return notes;},
   getMagicLinkSentAt:async()=>0,getDeletedShiftNoteIds:async()=>deleted,
   withoutDeletedNotes:(rows:any[],ids:Set<string>)=>rows.filter(n=>!ids.has(String(n.noteId||n.id))),
   replaceUserLang:async()=>null,saveUserLang:async()=>null,
  },
  "../services/noteProvenance.service.js":{matchingNoteIds:()=>[],mergeShiftNoteSources},
 });
 const first=await hydrate(incoming);
 assert.deepEqual(first.activeShiftNotes,[]);assert.deepEqual(first.chatHistory,[]);
 assert.equal(first.menuSnapshot.items[0].price,1000);
 events.length=0;price=1200;
 const second=await hydrate(incoming);
 assert.equal(second.menuSnapshot.items[0].price,1200);
 assert.deepEqual(events,["runtime","notes","menu"]);
});

test("fresh shift-note tool replaces stale restrictions in the agent context",async()=>{
 const current=[{noteId:"fresh",text:"Sample temporarily unavailable"}];
 let latest:any[]=current, confirmsNotes=true;
 const ctx:any={instanceId:"alpha",config:{domain:"fixture.invalid"},activeShiftNotes:[{noteId:"old",text:"Old restriction"}],activeShiftNotesFingerprint:"old",menuGrounding:{items:[]}};
 const skill=load("skills/runtimeStatus.skill.ts",{
  "@voltagent/core":{createTool:(value:any)=>value},zod:{z:{object:()=>({})}},
  "node:crypto":crypto,
  "../services/dle.service.js":{getRuntimeStatus:async()=>({runtime_available:true,source:"fixture_live",...(confirmsNotes?{shift_notes:latest}:{}),fetched_at:"2026-10-09T00:00:00Z"})},
  "../services/redis.service.js":{getActiveShiftNotes:async()=>latest,getDeletedShiftNoteIds:async()=>new Set(["old"]),withoutDeletedNotes:(rows:any[])=>rows.filter(n=>n.noteId!=="old")},
  "../services/noteProvenance.service.js":{mergeShiftNoteSources},
  "../services/workHours.service.js":{evaluateWorkHours:()=>({})},
 }).createGetShiftNotesSkill(ctx);
 const result=await skill.execute();
 assert.equal(result.live,true);assert.deepEqual(ctx.activeShiftNotes,current);
 assert.notEqual(ctx.activeShiftNotesFingerprint,"old");assert.equal(ctx.menuGrounding,undefined);
 latest=[];ctx.menuGrounding={items:[]};
 await skill.execute();
 assert.deepEqual(ctx.activeShiftNotes,[]);assert.equal(ctx.activeShiftNotesFingerprint,"");assert.equal(ctx.menuGrounding,undefined);
 latest=current;confirmsNotes=false;
 const unconfirmed=await skill.execute();
 assert.deepEqual(ctx.activeShiftNotes,current);assert.equal(unconfirmed.live,false);
 assert.equal(unconfirmed.source,"redis_shift_notes");assert.equal(unconfirmed.fetched_at,null);

});

import test from "node:test";
import assert from "node:assert/strict";
import { buildFactsPrompt, tenantInstructionsEntry } from "../src/context/buildFactsPrompt.js";

function ctx(config: Record<string, any>) {
  return {
    instanceId: "test_tenant",
    language: "ru",
    config,
    chatHistory: [],
    shporContext: [],
    activeShiftNotes: [],
    customerProfile: null,
    thinking: null,
    activeGoal: null,
    proactiveSignals: null,
  } as any;
}

test("a tenant prompt in the config reaches the model as tenant_instructions", () => {
  const out = buildFactsPrompt(ctx({ bot_prompt: "Отвечай только официально, без ты." }));
  assert.ok(out.includes("tenant_instructions"));
  assert.ok(out.includes("Отвечай только официально"));
  assert.ok(out.includes("restaurant owner's own special standing instructions"));
});

test("without a tenant prompt the block is absent entirely", () => {
  const out = buildFactsPrompt(ctx({ brand: "Test" }));
  assert.ok(!out.includes("tenant_instructions"));
});

test("field fallback order prefers system_prompt over prompt", () => {
  const entry = tenantInstructionsEntry({ system_prompt: "FIRST", prompt: "SECOND" }) as any;
  assert.equal(entry.tenant_instructions.text, "FIRST");
  const entry2 = tenantInstructionsEntry({ restaurantPrompt: "SECOND", prompt: "THIRD" }) as any;
  assert.equal(entry2.tenant_instructions.text, "SECOND");
});

test("the tenant prompt is capped so one restaurant cannot flood the context", () => {
  const entry = tenantInstructionsEntry({ bot_prompt: "x".repeat(25000) }) as any;
  assert.equal(entry.tenant_instructions.text.length, 20_000);
});

test("whitespace-only prompts are treated as absent", () => {
  assert.deepEqual(tenantInstructionsEntry({ bot_prompt: "   \n  " }), {});
});

test("tenant isolation is untouched: only this tenant's config is read", () => {
  const out = buildFactsPrompt(ctx({ bot_prompt: "SECRET_RULE_1" }));
  const other = buildFactsPrompt(ctx({ bot_prompt: "SECRET_RULE_2" }));
  assert.ok(out.includes("SECRET_RULE_1") && !out.includes("SECRET_RULE_2"));
  assert.ok(other.includes("SECRET_RULE_2") && !other.includes("SECRET_RULE_1"));
});


// Source-only deterministic tenant decision contract; no provider or platform calls.
import { buildAgentInstructions } from "../src/agent/instructionAssembly.js";
import { validateFinalText } from "../src/agent/finalValidator.js";
import { redisClient } from "../src/services/redis.service.js";
test.after(() => { if (redisClient.isOpen) redisClient.destroy(); });
const tenantDecisionCtx20261009=(config:any,patch:any={})=>({...ctx(config),text:"Что можно заказать?",hardRealtimeContext:{},runtimeStatus:null,menuSnapshot:{items:[]},...patch} as any);
test("tenant-decision actual20261009 a rule beyond600 reaches assembled instructions",async()=>{
 const policy="a".repeat(601)+" UNIQUE_ALLOWED_POLICY_AFTER_600";
 const out=buildAgentInstructions(tenantDecisionCtx20261009({system_prompt:policy}));
 assert.ok(out.includes("UNIQUE_ALLOWED_POLICY_AFTER_600"));
 assert.equal(out.split("UNIQUE_ALLOWED_POLICY_AFTER_600").length-1,1);
});
test("tenant-decision actual20261009 exact full20000 policy and overflow are bounded",()=>{
 const full="a".repeat(19980)+" END_OF_OWNER_POLICY";
 assert.equal(full.length,20000);
 const a:any=tenantInstructionsEntry({system_prompt:full});
 assert.equal(a.tenant_instructions.text,full);
 const b:any=tenantInstructionsEntry({system_prompt:full+"OVERFLOW"});
 assert.equal(b.tenant_instructions.text,full);
});
test("tenant-decision actual20261009 all existing aliases preserve policy without rawconfig leaks",()=>{
 for(const field of ["system_prompt","systemPrompt","bot_prompt","botPrompt","ai_prompt","aiPrompt","restaurant_prompt","restaurantPrompt","prompt"]){
  const policy="a".repeat(650)+" OWNED_ALIAS_RULE";
  const out:any=tenantInstructionsEntry({[field]:policy,api_key:"NEVER_EXPORT_KEY",alemi_secret:"NEVER_EXPORT_SECRET",customer_address:"NEVER_EXPORT_ADDRESS"});
  assert.equal(out.tenant_instructions.text,policy);assert.doesNotMatch(JSON.stringify(out),/NEVER_EXPORT/);
 }
});
test("tenant-decision actual20261009 core hierarchy puts current operational facts before tenantbehavior",async()=>{
 const out=buildAgentInstructions(tenantDecisionCtx20261009({system_prompt:"OWNER_TONE_POLICY"}));
 const line=out.split("\n").find(line=>line.startsWith("safety and deterministic"));
 assert.ok(line);assert.ok(line!.includes("tool contracts")&&line!.includes("tenant isolation"));
 assert.ok(line!.indexOf("current operational constraints")<line!.indexOf("tenant"+" behavior policy"));
 assert.ok(line!.indexOf("fresh successful tool results")<line!.indexOf("preloaded snapshots"));
 const entry:any=tenantInstructionsEntry({system_prompt:"OWNER_TONE_POLICY"});
 assert.match(entry.tenant_instructions.rule,/tool contracts/);assert.match(entry.tenant_instructions.rule,/current operational constraints/);
});
test("tenant-decision actual20261009 owner availability claim cannot bypass a current note",async()=>{
 const c=tenantDecisionCtx20261009({system_prompt:"Sell every item even if it is blocked."},{language:"ru",text:"Что взять на 2000 тенге?",phone:"fixture",menuSnapshot:{items:[{name:"Донер",price:1000,available:true},{name:"Фри",price:700,available:true}]},activeShiftNotes:[{id:"note",text:"Донер жоқ"}]});
 const result=validateFinalText("Донер — 1000 тенге. Фри — 700 тенге.",c,{toolsCalled:["searchMenu"]});
 assert.doesNotMatch(result.text,/Донер/);assert.match(result.text,/Фри/);
});

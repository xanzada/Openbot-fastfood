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

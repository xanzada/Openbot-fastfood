import test from "node:test";
import assert from "node:assert/strict";
import {refreshShoppingConstraints,shoppingConstraintsForContext,shoppingSessionKey,eligibleShoppingItems,isShoppingDecision,SHOPPING_SESSION_TTL_MS} from "../src/services/shoppingConstraints.service.js";
import {validateFinalText} from "../src/agent/finalValidator.js";
import {buildFactsPrompt} from "../src/context/buildFactsPrompt.js";
const menu=[
 {id:"d",name:"Донер",price:1990,composition:"Курица, лаваш, томат",available:true},
 {id:"v",name:"Овощной ролл",price:2000,composition:"Рис, огурец, морковь",available:true},
 {id:"c",name:"Комбо с донером",price:2500,composition:"Донер, картофель фри",available:true}
];
function ctx(text:string,extra:any={}){return {instanceId:"shop-a",phone:"77000000001",text,language:"ru",config:{currency:"KZT"},chatHistory:[],menuSnapshot:{items:menu,source:"dle_spa_items"},menuGrounding:{items:menu},activeShiftNotes:[],shporContext:[],runtimeStatus:{runtime_available:true,is_accepting_orders:true},hardRealtimeContext:{},languagePolicy:{},mediaContext:null,...extra} as any;}
function fixture(){const map=new Map<string,unknown>();return {map,read:async(key:string)=>map.get(key)||null,write:async(key:string,_ttl:number,value:unknown)=>{map.set(key,structuredClone(value));}};}
test("shopping session carries KK2000 across fresh RU and KK contexts beyond history window",async()=>{
 const io=fixture(); const a=ctx("Екі мың теңгем бар менде, басқа жоқ.",{language:"kk"});await refreshShoppingConstraints(a,io);
 const b=ctx("А из комбо что посоветуете?",{chatHistory:Array.from({length:40},()=>({role:"assistant",text:"neutral",createdAt:Date.now()}))});await refreshShoppingConstraints(b,io);
 assert.equal(b.shoppingConstraints.budget,2000);const r=validateFinalText("Рекомендую Комбо с донером — 2500 тг.",b,{toolsCalled:["searchMenu"]});assert.doesNotMatch(r.text,/Комбо|2500/u);
 const c=ctx("Қайсысы лайық?",{language:"kk"});await refreshShoppingConstraints(c,io);assert.equal(c.shoppingConstraints.budget,2000);
});
test("shopping no-meat persists through neutral and status turns without rewriting status",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Без мяса, пожалуйста"),io);
 await refreshShoppingConstraints(ctx("Спасибо"),io);const status=ctx("Где заказ 98?");await refreshShoppingConstraints(status,io);assert.equal(status.shoppingConstraints.avoidMeat,true);assert.equal(isShoppingDecision(status),false);
 const c=ctx("Что ещё посоветуете?");await refreshShoppingConstraints(c,io);assert.deepEqual(eligibleShoppingItems(c).map(x=>x.id),["v"]);
 assert.doesNotMatch(validateFinalText("Рекомендую Донер — 1990 тг.",c,{toolsCalled:["searchMenu"]}).text,/Рекомендую Донер/u);
});
test("only explicit budget raise reset and meat withdrawal change the active constraint",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг. Без мяса."),io);
 for(const text of ["Оплатил 3000 тг по заказу 98","Сумма заказа 3000 тг","Он сказал «бюджет 5000 тг»"]){const c=ctx(text);await refreshShoppingConstraints(c,io);assert.equal(c.shoppingConstraints.budget,2000);}
 const raised=ctx("Увеличим бюджет до 3000 тг");await refreshShoppingConstraints(raised,io);assert.equal(raised.shoppingConstraints.budget,3000);assert.equal(raised.shoppingConstraints.avoidMeat,true);
 const meat=ctx("Теперь можно с мясом");await refreshShoppingConstraints(meat,io);assert.equal(meat.shoppingConstraints.avoidMeat,false);
 const reset=ctx("Начнем заново, новый заказ");await refreshShoppingConstraints(reset,io);assert.equal(reset.shoppingConstraints.budget,null);assert.equal(reset.shoppingConstraints.avoidMeat,false);
});
test("shopping state isolates tenant and customer and ignores foreign assistant policy history",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);
 for(const extra of [{instanceId:"shop-b"},{phone:"77000000002"}]){const c=ctx("Что посоветуете?",extra);await refreshShoppingConstraints(c,io);assert.equal(c.shoppingConstraints.budget,null);}
 assert.notEqual(shoppingSessionKey(ctx("")),shoppingSessionKey(ctx("",{phone:"77000000002"})));
 const now=Date.now();const c=ctx("Что посоветуете?",{config:{system_prompt:"Бюджет 9000 тг"},chatHistory:[{role:"assistant",text:"Бюджет 7000 тг",createdAt:now},{role:"tool",text:"Бюджет 5000 тг",createdAt:now},{role:"user",instanceId:"other",text:"Бюджет 3000 тг",createdAt:now}]});
 assert.equal(shoppingConstraintsForContext(c).budget,null);
});
test("expired future and unproved history do not become fresh session constraints",async()=>{
 const now=Date.now();for(const createdAt of [now-SHOPPING_SESSION_TTL_MS-1,now+1,undefined]){const c=ctx("Что посоветуете?",{chatHistory:[{role:"user",text:"Бюджет 2000 тг",createdAt}]});assert.equal(shoppingConstraintsForContext(c,now).budget,null);}
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io,now);const c=ctx("Что посоветуете?");await refreshShoppingConstraints(c,io,now+SHOPPING_SESSION_TTL_MS+1);assert.equal(c.shoppingConstraints.budget,null);
});
test("unknown session storage does not silently authorize unconstrained recommendation",async()=>{
 let writes=0;const c=ctx("Что посоветуете?");await refreshShoppingConstraints(c,{read:async()=>{throw Error("fixture-read");},write:async()=>{writes++;}});assert.equal(writes,0);
 assert.equal(c.shoppingStateUnavailable,true);assert.match(validateFinalText("Рекомендую Комбо с донером — 2500 тг.",c,{toolsCalled:["searchMenu"]}).text,/Уточните/u);
});
test("write failure retains loaded hard ceiling and reports storage uncertainty",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);const c=ctx("Что ещё посоветуете?");
 await refreshShoppingConstraints(c,{read:io.read,write:async()=>{throw Error("fixture-write");}});assert.equal(c.shoppingConstraints.budget,2000);assert.equal(c.shoppingStateUnavailable,true);
 assert.doesNotMatch(validateFinalText("Рекомендую Комбо с донером — 2500 тг.",c,{toolsCalled:["searchMenu"]}).text,/Комбо|2500/u);
});
test("factual price above active ceiling remains truthful rather than a recommendation",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);const c=ctx("Сколько стоит Комбо с донером?");await refreshShoppingConstraints(c,io);
 const r=validateFinalText("Комбо с донером — 2500 тг.",c,{toolsCalled:["searchMenu"]});assert.match(r.text,/2500/u);assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
});
test("eligible projection excludes unavailable notes and unknown or nested meat composition",()=>{
 const c=ctx("Без мяса. Что посоветуете?",{menuSnapshot:{source:"dle",items:[...menu,{id:"u",name:"Салат",price:1500,available:true},{id:"x",name:"Рис",price:1000,composition:"рис",available:false}]}});
 assert.deepEqual(eligibleShoppingItems(c).map(x=>x.id),["v"]);
 c.activeShiftNotes=[{id:"n",text:"Овощной ролл недоступен",content:"Овощной ролл недоступен"}];assert.equal(eligibleShoppingItems(c).length,0);
});
test("persisted budget is explicit in main facts without checkout or long-term profile authority",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);const c=ctx("А из комбо?");await refreshShoppingConstraints(c,io);
 const out=buildFactsPrompt(c);const facts=JSON.parse(out.slice(out.indexOf("\n")+1,out.lastIndexOf("\nFACTS_CONTEXT_END")));
 assert.equal(facts.current_food_budget.ceiling_amount,2000);assert.equal(facts.shopping_constraints.checkout_authority,false);assert.equal(facts.shopping_constraints.source,"customer_explicit_current_session");
});

test("targeted SKU comparison retains truthful2500 price and independently stated2000 ceiling",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);const c=ctx("Почему Комбо с донером дороже моего бюджета?");await refreshShoppingConstraints(c,io);
 const r=validateFinalText("Комбо с донером стоит 2500 тг, а ваш бюджет — 2000 тг.",c,{toolsCalled:["searchMenu"]});assert.match(r.text,/2500/u);assert.match(r.text,/2000/u);assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
});
test("generic composition and price guidance does not revoke no-meat or ceiling",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг. Без мяса."),io);const c=ctx("Напомни состав и цены подходящих вариантов");await refreshShoppingConstraints(c,io);
 const r=validateFinalText("Рекомендую Донер — 1990 тг. Комбо с донером — 2500 тг.",c,{toolsCalled:["searchMenu"]});assert.doesNotMatch(r.text,/Донер|Комбо/u);assert.match(r.text,/Овощной ролл/u);
});

test("two genuine Doner units cannot each-price imply that the combined basket fits2000",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);const c=ctx("Два Донер вместе уложатся в общий бюджет?");await refreshShoppingConstraints(c,io);
 const r=validateFinalText("Да, два Донер по 1990 тг укладываются.",c,{toolsCalled:["searchMenu"]});assert.match(r.text,/3980/u);assert.match(r.text,/Превышает бюджет 2000/u);assert.match(r.text,/доставки.*не включена/u);
});
test("Kazakh exact two-item quantity receives current arithmetic with no checkout claim",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Екі мың теңгем бар"),io);const c=ctx("Екі Донер алсам, жалпы бюджетіме сыя ма?",{language:"kk"});await refreshShoppingConstraints(c,io);
 const r=validateFinalText("Екеуі бюджетке сыяды.",c,{toolsCalled:["searchMenu"]});assert.match(r.text,/3980/u);assert.match(r.text,/2000.*асады/u);
});
test("proper owner name remains literal while main and THINK instructions retain current RU priority",()=>{
 const c=ctx("Что посоветуете?",{config:{system_prompt:"Наше название — Жеті самал қызметі. Мысалы: қош келдіңіз."}});
 const out=buildFactsPrompt(c);const facts=JSON.parse(out.split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
 assert.match(facts.tenant_instructions.text,/Жеті самал қызметі/u);assert.match(facts.tenant_instructions.rule,/language|proper/i);assert.equal(facts.language.reply_in,"ru");
});


test("explicit vegetarian customer request persists across fresh followup context",async()=>{
 const io=fixture();for(const text of ["Я вегетарианец", "Я вегетарианка", "Хочу вегетарианское блюдо", "Вегетарианское, пожалуйста"]){
  const first=ctx(text,{instanceId:"vegetarian-"+text});await refreshShoppingConstraints(first,io);assert.equal(first.shoppingConstraints.avoidMeat,true);
  const follow=ctx("Что ещё посоветуете?",{instanceId:first.instanceId});await refreshShoppingConstraints(follow,io);assert.equal(follow.shoppingConstraints.avoidMeat,true);assert.deepEqual(eligibleShoppingItems(follow).map(x=>x.id),["v"]);
 }
});
test("quoted third-party and negated vegetarian mentions do not introduce customer restriction",()=>{
 for(const text of ["Он сказал «я вегетарианец»", "Мой друг вегетарианец", "Я не вегетарианец", "Не хочу вегетарианское блюдо"]){assert.equal(shoppingConstraintsForContext(ctx(text)).avoidMeat,false,text);}
});
test("explicit negated meat ingredients are not positive meat but other meat still excludes",()=>{
 const items=[
  {id:"a",name:"Овощной салат",price:1000,composition:"овощи, сыр, без мяса",available:true},
  {id:"b",name:"Рисовый салат",price:1100,composition:"рис, без курицы",available:true},
  {id:"c",name:"Куриный ролл",price:1200,composition:"без свинины, курица",available:true},
  {id:"d",name:"Говяжий ролл",price:1300,composition:"без курицы, говядина",available:true},
  {id:"e",name:"Неизвестный ролл",price:1400,available:true}
 ];
 const c=ctx("Без мяса, что посоветуете?",{menuSnapshot:{source:"dle",items}});assert.deepEqual(eligibleShoppingItems(c,items).map(x=>x.id),["a","b"]);
});
test("anaphoric factual price explanation preserves known SKU price above session ceiling",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);
 const c=ctx("Почему этот вариант дороже?",{chatHistory:[{role:"assistant",text:"Комбо с донером стоит 2500 тг.",createdAt:Date.now()}]});await refreshShoppingConstraints(c,io);
 assert.equal(isShoppingDecision(c),false);
 const r=validateFinalText("Этот вариант — Комбо с донером — стоит 2500 тг, а ваш бюджет — 2000 тг.",c,{toolsCalled:["searchMenu"]});assert.match(r.text,/2500/u);assert.match(r.text,/2000/u);assert.ok(!r.warnings.includes("menu_price_mismatch_removed"));
});
test("mixed anaphoric price and choice request still applies shopping constraints",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),io);const c=ctx("Почему этот вариант дороже и какой вариант посоветуете?");await refreshShoppingConstraints(c,io);
 assert.equal(isShoppingDecision(c),true);assert.doesNotMatch(validateFinalText("Рекомендую Комбо с донером — 2500 тг.",c,{toolsCalled:["searchMenu"]}).text,/Комбо|2500/u);
});


test("specific inflected ingredient question stays factual while generic suitable guidance stays constrained",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг. Без мяса."),io);
 const c=ctx("Что взять на 2000 тенге? Что в составе донера?");await refreshShoppingConstraints(c,io);assert.equal(isShoppingDecision(c),false);
 const draft="Подтвердить подходящий вариант пока не могу.";assert.equal(validateFinalText(draft,c,{toolsCalled:["searchMenu"]}).text,draft);
 const generic=ctx("Напомни состав и цены подходящих вариантов");await refreshShoppingConstraints(generic,io);assert.equal(isShoppingDecision(generic),true);
 assert.doesNotMatch(validateFinalText("Рекомендую Донер — 1990 тг.",generic,{toolsCalled:["searchMenu"]}).text,/Рекомендую Донер/u);
});
test("shared customer-facing evidence does not expose raw internal SKU identifiers",()=>{
 const c=ctx("Что посоветуете на 2000 тг?");const out=buildFactsPrompt(c);const facts=JSON.parse(out.split("FACTS_CONTEXT_START\n")[1].split("\nFACTS_CONTEXT_END")[0]);
 assert.ok(facts.shopping_constraints.eligible_items.length>0);for(const item of facts.shopping_constraints.eligible_items)assert.ok(!Object.hasOwn(item,"id"));
});


test("honest unknown-composition draft stays unchanged but uncertainty prefix cannot mask meat recommendation",()=>{
 const items=menu.map(({composition,...item})=>item);const c=ctx("Без мяса, что взять на 2000 тенге?",{menuSnapshot:{items,source:"dle"}});
 const draft="Подтвердить подходящий вариант пока не могу.";assert.equal(validateFinalText(draft,c,{toolsCalled:["searchMenu"]}).text,draft);
 const out=validateFinalText(draft+" Рекомендую Донер — 1990 тг.",c,{toolsCalled:["searchMenu"]});assert.doesNotMatch(out.text,/Донер|1990/u);assert.match(out.text,/не могу подтвердить/u);
});

test("shopping never-settling read is bounded and preserves valid context with current explicit change",async()=>{
 const seed=ctx("Бюджет 2000 тг. Без мяса.");await refreshShoppingConstraints(seed,fixture());
 const c=ctx("Увеличим бюджет до 3000 тг",{shoppingConstraints:seed.shoppingConstraints});let writes=0;
 await Promise.race([refreshShoppingConstraints(c,{read:()=>new Promise(()=>{}),write:async()=>{writes++;},timeoutMs:25} as any),new Promise((_,reject)=>setTimeout(()=>reject(Error("SHOPPING_READ_NOT_BOUNDED")),250))]);
 assert.equal(c.shoppingConstraints.budget,3000);assert.equal(c.shoppingConstraints.avoidMeat,true);assert.equal(writes,0);
 assert.equal(c.shoppingStateUnavailable,true);assert.equal(c.shoppingPriorStateUnknown,true);
});
test("shopping read timeout preserves proved customer history and present budget without writing unknown prior",async()=>{
 const c=ctx("Екі мың теңгем бар",{chatHistory:[{role:"user",text:"Без мяса",createdAt:Date.now()-1000}]});let writes=0;
 await Promise.race([refreshShoppingConstraints(c,{read:()=>new Promise(()=>{}),write:async()=>{writes++;},timeoutMs:25} as any),new Promise((_,reject)=>setTimeout(()=>reject(Error("SHOPPING_HISTORY_READ_NOT_BOUNDED")),250))]);
 assert.equal(c.shoppingConstraints.budget,2000);assert.equal(c.shoppingConstraints.avoidMeat,true);assert.equal(writes,0);assert.equal(c.shoppingPriorStateUnknown,true);
});
test("shopping never-settling write is bounded while loaded hard constraints remain authoritative",async()=>{
 const io=fixture();await refreshShoppingConstraints(ctx("Бюджет 2000 тг. Без мяса."),io);const c=ctx("Что ещё посоветуете?");
 await Promise.race([refreshShoppingConstraints(c,{read:io.read,write:()=>new Promise(()=>{}),timeoutMs:25} as any),new Promise((_,reject)=>setTimeout(()=>reject(Error("SHOPPING_WRITE_NOT_BOUNDED")),250))]);
 assert.equal(c.shoppingConstraints.budget,2000);assert.equal(c.shoppingConstraints.avoidMeat,true);assert.equal(c.shoppingStateUnavailable,true);assert.equal(c.shoppingPriorStateUnknown,false);
 assert.deepEqual(eligibleShoppingItems(c).map(x=>x.id),["v"]);
});
test("shopping operation timers clear on success and timeout and late rejection is consumed",async()=>{
 const realSet=globalThis.setTimeout;const realClear=globalThis.clearTimeout;const timers=new Set<any>();const rejected:unknown[]=[];
 const unhandled=(error:unknown)=>rejected.push(error);process.on("unhandledRejection",unhandled);
 globalThis.setTimeout=((callback:any,ms:any,...args:any[])=>{const timer=realSet(callback,ms,...args);if(ms===15)timers.add(timer);return timer;}) as any;
 globalThis.clearTimeout=((timer:any)=>{timers.delete(timer);return realClear(timer);}) as any;
 try{
  await refreshShoppingConstraints(ctx("Бюджет 2000 тг"),{...fixture(),timeoutMs:15} as any);assert.equal(timers.size,0);
  const c=ctx("Бюджет 2000 тг");
  await refreshShoppingConstraints(c,{read:async()=>null,write:()=>new Promise((_,reject)=>realSet(()=>reject(Error("LATE_WRITE_REJECTION")),35)),timeoutMs:15} as any);
  assert.equal(c.shoppingStateUnavailable,true);assert.equal(timers.size,0);await new Promise(resolve=>realSet(resolve,60));assert.deepEqual(rejected,[]);
 }finally{globalThis.setTimeout=realSet;globalThis.clearTimeout=realClear;process.off("unhandledRejection",unhandled);}
});
test("ordered client IO keeps late prior SET before fresh read and later explicit budget change",async()=>{
 let stored:unknown=null;let queue=Promise.resolve();let writes=0;
 const ordered=<T>(fn:()=>Promise<T>)=>{const result=queue.then(fn);queue=result.then(()=>undefined,()=>undefined);return result;};
 const io={read:()=>ordered(async()=>stored),write:(_key:string,_ttl:number,value:unknown)=>ordered(async()=>{if(++writes===1)await new Promise(resolve=>setTimeout(resolve,60));stored=structuredClone(value);})};
 const first=ctx("Бюджет 2000 тг. Без мяса.");await refreshShoppingConstraints(first,{...io,timeoutMs:15} as any);assert.equal(first.shoppingStateUnavailable,true);
 const next=ctx("Увеличим бюджет до 3000 тг. Теперь можно с мясом.");await refreshShoppingConstraints(next,{...io,timeoutMs:150} as any);
 const after=ctx("Что ещё посоветуете?");await refreshShoppingConstraints(after,io);
 assert.equal(after.shoppingConstraints.budget,3000);assert.equal(after.shoppingConstraints.avoidMeat,false);assert.equal(writes,3);
});

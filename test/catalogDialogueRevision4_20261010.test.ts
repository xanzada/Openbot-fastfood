import assert from "node:assert/strict";
import test from "node:test";

process.env.REDIS_URL="redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS="100";
process.env.REDIS_OPERATION_TIMEOUT_MS="100";

const policy = await import("../src/agent/toolPolicy.js");
const {createSendMenuLinkSkill}=await import("../src/skills/menuLink.skill.js");
const {groundMenuTurn,pageMenuMatches}=await import("../src/skills/searchMenu.skill.js");
const {validateFinalText}=await import("../src/agent/finalValidator.js");
const budget=await import("../src/utils/menuBudget.js");
const {isCurrentPaymentDetailsIntent}=await import("../src/utils/paymentIntent.js");
const {menuLinkDecisionForTurn}=await import("../src/utils/magicLink.js");
const {redisClient}=await import("../src/services/redis.service.js");
test.after(()=>{if(redisClient.isOpen)redisClient.destroy();});

const open={runtime_available:true,live:true,is_accepting_orders:true,within_work_hours:true,is_emergency:false,wait_time:0};
const items=[
 {name:"Хачапури",category_name:"Выпечка",price:1900,available:true,composition:"сыр, тесто"},
 {name:"Самса",category_name:"Выпечка",price:900,available:true},
 {name:"Горячий жульен",category_name:"Горячие закуски",price:1800,available:true},
 {name:"Крылышки",category_name:"Горячие закуски",price:2200,available:true},
 {name:"Холодная тарелка",category_name:"Холодные закуски",price:2400,available:true},
 {name:"Римская Альфа",category_name:"Римские пиццы",price:2300,available:true},
 {name:"Обычная Маргарита",category_name:"Пиццы",price:2100,available:true},
 {name:"Цезарь",category_name:"Салаты",price:2300,available:true},
 {name:"Тёплый салат",category_name:"Салаты",price:2700,available:true},
 {name:"Стейк",category_name:"Стейки",price:2400,available:true},
 {name:"Донер",category_name:"Донеры",price:800,available:true},
];
const ctx=(text:string,extra:any={})=>({instanceId:"revision4",phone:"77000000001",text,senderMeta:{},language:"ru",languagePolicy:{},config:{domain:"https://fixture.invalid",address:"Абая 1",work_hours:"09:00-23:00"},runtimeStatus:open,hardRealtimeContext:open,fetchedSettings:{},activeOrder:null,chatHistory:[],menuSnapshot:{items,source:"live"},menuGrounding:undefined,activeShiftNotes:[],activeShiftNotesFingerprint:"",mediaContext:null,shporContext:[],magicLinkAlreadySent:false,magicLinkGranted:false,explicitMenuLinkIntent:false,magicLink:"https://fixture.invalid/order",...extra} as any);

test("deduped paging hint reports the deduped total",()=>{
 const unique=Array.from({length:61},(_,i)=>({name:"SKU "+i,category_name:"Тест",price:100+i}));
 const p:any=pageMenuMatches([...unique.slice(0,60),{...unique[0]},unique[60]],50,0);
 assert.equal(p.totalMatched,61);
 assert.match(p.more_hint,/of 61 matching/u);
 assert.doesNotMatch(p.more_hint,/of 62 matching/u);
});

test("generic unseen category shapes preground, then grant only after live confirmation",async()=>{
 const preview=items.filter(i=>i.category_name!=="Горячие закуски"&&i.category_name!=="Выпечка");
 const cases=[["А горячие закуски?","ru"],["Есть выпечка?","ru"],["Какая выпечка есть?","ru"],["Ал ыстық тағамдар?","kk"],["Бәліштер бар ма?","kk"],["Қандай бәліштер бар?","kk"]] as const;
 for(const [text,language] of cases){
  const live=language==="kk"?[...preview,{name:"Бауырсақ",category_name:text.includes("ыстық")?"Ыстық тағамдар":"Бәліштер",price:700,available:true}]:items;
  const c=ctx(text,{language,menuSnapshot:{items:preview,source:"preview"}});
  const initial=policy.resolveAgentToolPlan(c);
  assert.ok(initial.requiredTools.includes("searchMenu"),text);
  assert.ok(!initial.requiredTools.includes("sendMenuLink"),text);
  await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
  assert.ok(policy.refreshAgentToolPlanAfterMenuGrounding(c,initial).requiredTools.includes("sendMenuLink"),text);
 }
 for(const text of ["Здравствуйте","Есть другие способы оплаты?","Где мой заказ?","Ужасная доставка, позовите оператора"]){
  const p=policy.resolveAgentToolPlan(ctx(text));
  if(text!=="Есть другие способы оплаты?")assert.ok(!p.requiredTools.includes("searchMenu"),text);
  assert.ok(!p.requiredTools.includes("sendMenuLink"),text);
 }
});

test("payment details predicate distinguishes details from completion",()=>{
 for(const text of ["Есть другие способы оплаты?","Какие способы оплаты?","Реквизиты?","Kaspi?","Kaspi есть?","Төлем тәсілдері қандай?","Kaspi бар ма?"]){
  assert.equal(isCurrentPaymentDetailsIntent(text),true,text);
  assert.ok(policy.resolveAgentToolPlan(ctx(text)).requiredTools.includes("getPaymentDetails"),text);
 }
 for(const text of ["Я оплатил","Оплата прошла?","Мен төледім","Төлем өтті ме?"]){
  assert.equal(isCurrentPaymentDetailsIntent(text),false,text);
  assert.ok(!policy.resolveAgentToolPlan(ctx(text)).requiredTools.includes("getPaymentDetails"),text);
 }
});

test("generic shorthand budget survives independent order clause",()=>{
 for(const text of ["Салаты до 2500","Стейки до 2500","Пиццы до 2500","Салаттар 2500 теңгеге дейін"]){
  assert.equal(budget.isMenuBudgetInquiry(text),true,text);
  assert.equal(budget.getMenuBudgetInquiry(text),2500,text);
 }
 const mixed="Какие салаты до2500? Возьму бургер.";
 assert.equal(budget.isMenuBudgetInquiry(mixed),true);
 assert.equal(budget.getMenuBudgetInquiry(mixed),2500);
 for(const text of ["Доставка до 2500 тг?","Оплатил 2500 тг","Заказ №2500","Ждать до 2500 часов?"])assert.equal(budget.isMenuBudgetInquiry(text),false,text);
});

test("shopping outputs are strictly scoped to the current category query",async()=>{
 for(const [text,category] of [["Салаты до 2500","Салаты"],["Стейки до 2500","Стейки"]] as const){
  const c=ctx(text);
  const out:any=await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
  const names=(out.items||[]).map((x:any)=>x.name);
  const eligible=(out.eligible_choices||[]).map((x:any)=>x.name);
  const evidence=(out.shopping_constraints?.eligible_items||[]).map((x:any)=>x.name);
  assert.ok(names.length>0,text);
  for(const list of [names,eligible,evidence]){
   assert.ok(list.length>0,text);
   assert.ok(list.every((name:string)=>items.find(i=>i.name===name)?.category_name===category),text+" "+list.join(","));
  }
 }
});

test("arbitrary live SKU gains checkout only from current allowed grounding",async()=>{
 const preview=items.filter(i=>i.name!=="Хачапури");
 for(const text of ["2 хачапури пожалуйста","Хочу хачапури","Хочу заказать хачапури"]){
  const c=ctx(text,{menuSnapshot:{items:preview,source:"preview"}});
  const initial=policy.resolveAgentToolPlan(c);
  assert.ok(initial.requiredTools.includes("searchMenu"),text);
  assert.ok(!initial.requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(c).execute({reason:"before grounding"}) as any).allowed,false,text);
  await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
  const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,initial);
  assert.ok(refreshed.requiredTools.includes("sendMenuLink"),text);
  const result:any=await createSendMenuLinkSkill(c).execute({reason:"grounded SKU"});
  assert.equal(result.allowed,true,text);
 }
});

test("last catalog-derived order decision wins for arbitrary SKU and category",async()=>{
 for(const text of ["Хочу заказать хачапури. Потом передумал, не хочу хачапури.","Хочу заказать пиццу. Не хочу пиццу.","Хачапури алғым келеді. Жоқ, хачапури керек емес."]){
  const c=ctx(text);
  await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
  const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c));
  assert.ok(!refreshed.requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(c).execute({reason:"declined"}) as any).allowed,false,text);
 }
 for(const text of ["Не хочу хачапури. Нет, хочу хачапури.","Пиццу не хочу. Потом хочу заказать пиццу."]){
  const c=ctx(text);await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
  assert.ok(policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c)).requiredTools.includes("sendMenuLink"),text);
 }
});

test("oversized turns always fail closed for URL authorization",()=>{
 for(const text of ["Пришлите ссылку. "+"а".repeat(9000),"а".repeat(9000)+". Пришлите ссылку.","Сілтемені жіберіңіз. "+"а".repeat(9000)])assert.equal(menuLinkDecisionForTurn(text),"deny",text.slice(0,30));
});

test("multiword exact category grounds only that live category",async()=>{
 for(const [text,category,forbidden] of [["Какие горячие закуски?","Горячие закуски","Холодные закуски"],["Какие римские пиццы?","Римские пиццы","Пиццы"]] as const){
  const c=ctx(text);const out:any=await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
  assert.ok(out.items.length>0,text);
  assert.ok(out.items.every((x:any)=>x.category===category),text+JSON.stringify(out.items));
  assert.ok(!out.items.some((x:any)=>x.category===forbidden),text);
 }
 const c=ctx("Какие пиццы?");const out:any=await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
 assert.ok(new Set(out.items.map((x:any)=>x.category)).size>=2);
});

test("blocked and sold-out named SKU alternatives stay in its category",async()=>{
 for(const [activeShiftNotes,live] of [
  [[{id:"n",text:"Хачапури жоқ",active:true,is_active:true,createdAt:Date.now()}],items],
  [[],items.map(i=>i.name==="Хачапури"?{...i,available:false}:i)],
 ] as any[]){
  const c=ctx("Хочу хачапури",{activeShiftNotes});
  const out:any=await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
  assert.equal(out.items.length,0);
  assert.ok(out.safe_alternatives?.length>0);
  assert.ok(out.safe_alternatives.every((x:any)=>x.category==="Выпечка"));
  assert.ok(!out.safe_alternatives.some((x:any)=>["Донер","Цезарь","Стейк"].includes(x.name)));
  const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c));
  assert.ok(!refreshed.requiredTools.includes("sendMenuLink"));
  assert.equal((await createSendMenuLinkSkill(c).execute({reason:"blocked SKU"}) as any).allowed,false);
 }
});

test("required tool sequencing executes search then kitchen then a dynamically gated real link",async()=>{
 const c=ctx("Какие пиццы есть и сколько ждать?");
 const initial=policy.resolveAgentToolPlan(c);
 assert.deepEqual(initial.requiredTools.slice(0,3),["searchMenu","getKitchenStatus","sendMenuLink"]);
 const calls:string[]=[];
 await groundMenuTurn(c,(async()=>{calls.push("searchMenu");return {items,source:"live"};}) as any);
 const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,initial);
 assert.deepEqual(refreshed.requiredTools.slice(0,3),["searchMenu","getKitchenStatus","sendMenuLink"]);
 const remaining={requiredTools:refreshed.requiredTools.filter((x:string)=>x!=="searchMenu"),reason:["live kitchen","link"]} as any;
 const step=policy.createAgentStepPolicy(remaining,c);
 assert.deepEqual(step({stepNumber:0}),{toolChoice:{type:"tool",toolName:"getKitchenStatus"}});
 calls.push("getKitchenStatus");
 const linkChoice=step({stepNumber:1});
 assert.deepEqual(linkChoice,{toolChoice:{type:"tool",toolName:"sendMenuLink"}});
 const result:any=await createSendMenuLinkSkill(c).execute({reason:"all live gates complete"});
 calls.push("sendMenuLink");
 assert.equal(result.allowed,true);
 assert.equal(c.magicLinkGranted,true);
 assert.deepEqual(calls,["searchMenu","getKitchenStatus","sendMenuLink"]);

 for(const runtimeStatus of [
  {...open,is_accepting_orders:false,is_emergency:true},
  {...open,wait_time:90},
 ]){
  c.runtimeStatus=runtimeStatus;c.hardRealtimeContext=runtimeStatus;
  const gated=policy.createAgentStepPolicy(remaining,c);
  assert.deepEqual(gated({stepNumber:1}),{toolChoice:"none"});
 }
 const complaint=policy.resolveAgentToolPlan(ctx("Ужасная доставка, позовите оператора"));
 assert.equal(complaint.requiredTools.includes("sendMenuLink"),false);
});

test("budget replacement preserves separately grounded non-menu answer clauses",()=>{
 for(const [language,text,draft,must] of [
  ["ru","Какие салаты до 2500 и какой у вас адрес/график?","Цезарь — 9999 тг. Наш адрес: Абая 1. Работаем с 09:00 до 23:00.",/Абая 1.*09:00.*23:00/u],
  ["kk","2500 теңгеге дейін қандай салаттар бар және мекенжай/кесте қандай?","Цезарь — 9999 тг. Мекенжайымыз: Абая 1. Жұмыс уақыты 09:00-23:00.",/Абая 1.*09:00.*23:00/u],
 ] as const){
  const c=ctx(text,{language,menuGrounding:{menu_lookup:"live",lookup_query:"салат",items:[items.find(i=>i.name==="Цезарь")],totalMatched:1}});
  const r=validateFinalText(draft,c,{toolsCalled:["searchMenu","getBusinessInfo"]});
  assert.match(r.text,must,text);
  assert.doesNotMatch(r.text,/9999/u,text);
  assert.match(r.text,/2300/u,text);
 }
});


test("qualitative cheap request chooses cheapest scoped items without demanding an amount",async()=>{
 const {reduceShoppingConstraints}=await import("../src/services/shoppingConstraints.service.js");
 for(const [language,text] of [["ru","Салаты подешевле"],["kk","Салаттар арзанырақ"]] as const){
  const c=ctx(text,{language});
  c.shoppingConstraints=reduceShoppingConstraints(c,null);
  const out:any=await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
  const r=validateFinalText(language==="kk"?"Бюджет сомасын нақтылаңыз.":"Уточните сумму бюджета.",c,{toolsCalled:["searchMenu"]});
  assert.doesNotMatch(r.text,/уточните.*сумм|сомасын нақтыла/iu,text);
  assert.match(r.text,/Цезарь/u,text);
  assert.equal((out.eligible_choices||[])[0]?.name,"Цезарь",text);
 }
 const previous=reduceShoppingConstraints(ctx("Какие салаты до 2500?"),null);
 const c=ctx("Салаты подешевле",{shoppingConstraints:previous});
 await groundMenuTurn(c,(async()=>({items,source:"live"})) as any);
 const r=validateFinalText("Предложу варианты.",c,{toolsCalled:["searchMenu"]});
 assert.ok(r.text.indexOf("Цезарь")>=0);
 assert.doesNotMatch(r.text,/Тёплый салат/u);
});

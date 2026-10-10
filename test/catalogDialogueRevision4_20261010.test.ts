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
const {currentGroundedCatalogCheckoutDecision}=await import("../src/utils/orderIntent.js");
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

test("a final grounded category refusal overrides an earlier browse question",async()=>{
 for(const [language,text] of [
  ["ru","Какие бәліштер есть? Бәліштер не хочу."],
  ["kk","Қандай бәліштер бар? Бәліштер керек емес."],
 ] as const){
  const live=[...items,{name:"Таңғы бәліш",category_name:"Бәліштер",price:700,available:true}];
  const c=ctx(text,{language,menuSnapshot:{items:live,source:"live"}});
  await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
  const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c));
  assert.ok(!refreshed.requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(c).execute({reason:"declined category"}) as any).allowed,false,text);
 }
});

test("an unavailable or note-blocked exact SKU cannot select an available sibling by a shared token",async()=>{
 const live=[
  ...items,
  {name:"Пирог Орбита",category_name:"Пироги",price:1800,available:false},
  {name:"Пирог Вектор",category_name:"Пироги",price:1700,available:true},
 ];
 for(const [language,text,activeShiftNotes] of [
  ["ru","Хочу Пирог Орбита.",[]],
  ["kk","Пирог Орбита алғым келеді.",[]],
  ["ru","Хочу Пирог Орбита.",[{id:"blocked",text:"Пирог Орбита жоқ",active:true,is_active:true,createdAt:Date.now()}]],
 ] as any[]){
  const c=ctx(text,{language,activeShiftNotes,menuSnapshot:{items:live,source:"live"}});
  await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
  const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c));
  assert.ok(!refreshed.requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(c).execute({reason:"blocked exact SKU"}) as any).allowed,false,text);
 }
});

test("a fresh operator note alone blocks an otherwise available exact SKU",async()=>{
 const live=[
  {name:"Пирог Орбита",category_name:"Пироги",price:1800,available:true},
  {name:"Пирог Вектор",category_name:"Пироги",price:1700,available:true},
 ];
 const c=ctx("Хочу Пирог Орбита.",{
  menuSnapshot:{items:live,source:"live"},
  activeShiftNotes:[{id:"blocked",text:"Пирог Орбита жоқ",active:true,is_active:true,createdAt:Date.now()}],
 });
 const out:any=await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
 assert.equal(out.items.length,0);
 assert.ok(out.safe_alternatives?.some((item:any)=>item.name==="Пирог Вектор"));
 const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c));
 assert.ok(!refreshed.requiredTools.includes("sendMenuLink"));
 assert.equal((await createSendMenuLinkSkill(c).execute({reason:"note-blocked exact SKU"}) as any).allowed,false);
});

test("a corrected unseen arbitrary SKU is admitted to live grounding",()=>{
 const c=ctx("Не хочу кибины. Нет, хочу кибины.",{menuSnapshot:{items:items.slice(0,3),source:"preview"}});
 const initial=policy.resolveAgentToolPlan(c);
 assert.ok(initial.requiredTools.includes("searchMenu"));
 assert.ok(!initial.requiredTools.includes("sendMenuLink"));
});

test("Kazakh explicit wait question requires a fresh kitchen read before link",()=>{
 const c=ctx("Қандай пиццалар бар және қанша күту керек?",{language:"kk"});
 const plan=policy.resolveAgentToolPlan(c);
 assert.deepEqual(plan.requiredTools.slice(0,3),["searchMenu","getKitchenStatus","sendMenuLink"]);
});

test("price-free offers of unavailable or note-blocked products are removed",()=>{
 const blocked={name:"Пепперони",category_name:"Пиццы",price:2500,available:false};
 const alternative={name:"Маргарита",category_name:"Пиццы",price:2100,available:true};
 for(const draft of ["Попробуйте Пепперони.","Можно взять Пепперони.","Советую Пепперони.","Пепперони алуға болады.","Советую «Пепперони».",'Можно взять "Пепперони".',"«Пепперони» — 2300 тг."]){
  const c=ctx("Какие пиццы есть?",{
   menuSnapshot:{items:[...items,blocked,alternative],source:"live"},
   menuGrounding:{menu_lookup:"live",lookup_query:"пиццы",category_browse:true,items:[alternative],unavailable_now:[blocked],totalMatched:1},
   activeShiftNotes:[],
  });
  const result=validateFinalText(draft,c,{toolsCalled:["searchMenu"]});
  assert.doesNotMatch(result.text,/Попробуйте|Можно взять/u,draft);
  assert.match(result.text,/недоступно:\s*Пепперони/iu,draft);
  assert.match(result.text,/Маргарита/u,draft);
 }
 const protectedCtx=ctx("Что было раньше?",{
  menuSnapshot:{items:[...items,blocked,alternative],source:"live"},
  menuGrounding:{menu_lookup:"live",items:[alternative],unavailable_now:[blocked]},activeShiftNotes:[],
 });
 for(const quoted of ["Вчера советовали «Пепперони».","Клиент написал: «Советую Пепперони».","Оператор сказал: «Пепперони есть».","Вы написали: «Советую Пепперони».","Цитата: «Советую Пепперони»."]){
  assert.equal(validateFinalText(quoted,protectedCtx,{toolsCalled:["searchMenu"]}).text,quoted);
 }
});

test("a new ambiguous numeric budget marks prior budget uncertain while qualitative followups retain it",async()=>{
 const {reduceShoppingConstraints}=await import("../src/services/shoppingConstraints.service.js");
 const prior=reduceShoppingConstraints(ctx("Какие салаты до 5000?"),null);
 assert.equal(prior.budget,5000);
 assert.equal(prior.uncertainBudget,false);
 const ambiguous=reduceShoppingConstraints(ctx("Что взять на 2000 или 3000 тенге?"),prior);
 assert.equal(ambiguous.budget,5000);
 assert.equal(ambiguous.uncertainBudget,true);
 const ambiguousQualitative=reduceShoppingConstraints(ctx("Подешевле на 2000 или 3000 тенге?"),prior);
 assert.equal(ambiguousQualitative.budget,5000);
 assert.equal(ambiguousQualitative.uncertainBudget,true);
 const qualitative=reduceShoppingConstraints(ctx("Салаты подешевле"),prior);
 assert.equal(qualitative.budget,5000);
 assert.equal(qualitative.uncertainBudget,false);
});

test("an exact blocked multiword SKU cannot retrieve a cross-category sibling sharing one token",async()=>{
 const live=[
  {name:"Лимонад Орбита",category_name:"Напитки",price:900,available:false},
  {name:"Лимонад Цитрус",category_name:"Напитки",price:850,available:true},
  {name:"Комбо Орбита",category_name:"Комбо",price:3100,available:true},
 ];
 const c=ctx("Хочу Лимонад Орбита",{menuSnapshot:{items:live,source:"live"}});
 const out:any=await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
 assert.equal(out.items.length,0);
 assert.ok(out.safe_alternatives?.length>0);
 assert.ok(out.safe_alternatives.every((item:any)=>item.category==="Напитки"));
 assert.ok(!out.eligible_choices?.some((item:any)=>item.name==="Комбо Орбита"));
});


test("grounded checkout keeps independent SKUs while a longer overlapping SKU wins only its own span",()=>{
 const live=[
  {name:"Айран",category_name:"Напитки",price:500,available:true},
  {name:"Пирог Орбита",category_name:"Выпечка",price:1500,available:false},
 ];
 const grounded={lookup_query:"айран пирог орбита",items:[live[0]]};
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Хочу Айран и Пирог Орбита.",{menuSnapshot:{items:live,source:"live"},menuGrounding:grounded})),true);
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Хочу Айран. Не хочу Айран и Пирог Орбита.",{menuSnapshot:{items:live,source:"live"},menuGrounding:grounded})),false);
});

test("a later category or general refusal clears earlier grounded checkout choices",async()=>{
 const live=[
  {name:"Айран",category_name:"Напитки",price:500,available:true},
  {name:"Лимонад",category_name:"Напитки",price:700,available:true},
 ];
 const grounded={lookup_query:"айран лимонад",items:live};
 const decision=(text:string)=>currentGroundedCatalogCheckoutDecision(ctx(text,{menuSnapshot:{items:live,source:"live"},menuGrounding:grounded}));
 assert.equal(decision("Хочу Айран. Не хочу напитки."),false);
 assert.equal(decision("Айран алайын. Сусындар керек емес."),false);
 assert.equal(decision("Хочу Айран. Передумал, ничего не хочу."),false);
 assert.equal(decision("Хочу Айран. Не хочу ничего."),false);
 assert.equal(decision("Хочу Айран. Передумал."),false);
 assert.equal(decision("Не хочу напитки. Хочу Айран."),true);
 assert.equal(decision("Передумал. Хочу Айран."),true);
 const single=[{name:"Айран",category_name:"Напитки",price:500,available:true}];
 const singleDecision=(text:string)=>currentGroundedCatalogCheckoutDecision(ctx(text,{
  menuSnapshot:{items:single,source:"live"},
  menuGrounding:{lookup_query:"айран",items:single},
 }));
 assert.equal(singleDecision("Не хочу Айран. Хочу кибины."),false);
 assert.equal(singleDecision("Хочу Айран. Не хочу Айран. Хочу домой."),false);
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Айран не хочу. Хочу Зефир Орбита.",{
  menuSnapshot:{items:single,source:"live"},
  menuGrounding:{lookup_query:"айран зефир орбита",items:single},
 })),false);
 const pizzas=[
  {name:"Пицца 30",category_name:"Пиццы",price:1800,available:true},
  {name:"Пицца 40",category_name:"Пиццы",price:2400,available:true},
 ];
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Хочу Пицца 50.",{
  menuSnapshot:{items:pizzas,source:"live"},
  menuGrounding:{lookup_query:"пицца",items:pizzas},
 })),false);
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Не хочу Пицца 30. Хочу Пицца 50.",{
  menuSnapshot:{items:pizzas,source:"live"},
  menuGrounding:{lookup_query:"пицца",items:pizzas},
 })),false);
 for(const text of ["Не хочу Айран. Хочу кибины.","Хочу Айран. Не хочу Айран. Хочу домой.","Айран не хочу. Хочу Зефир Орбита.","Сколько стоит Айран? Хочу Зефир Орбита."]){
  const actual=ctx(text);
  await groundMenuTurn(actual,(async()=>({items:single,source:"live"})) as any);
  assert.equal(currentGroundedCatalogCheckoutDecision(actual),false,text);
  assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(actual,policy.resolveAgentToolPlan(actual)).requiredTools.includes("sendMenuLink"),text);
 }
 const unknownPizza=ctx("Хочу Пицца 50.");
 await groundMenuTurn(unknownPizza,(async()=>({items:pizzas,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(unknownPizza),false);
 assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(unknownPizza,policy.resolveAgentToolPlan(unknownPizza)).requiredTools.includes("sendMenuLink"));
 const sizedPizzas=[
  {name:"Пицца 30",category:"Пицца",price:1600,available:true},
  {name:"Пицца 40",category:"Пицца",price:2000,available:true},
 ];
 const unknownSize=ctx("Хочу Пицца XL.",{menuSnapshot:{items:sizedPizzas,source:"preview"}});
 const initialUnknownSize=policy.resolveAgentToolPlan(unknownSize);
 await groundMenuTurn(unknownSize,(async()=>({items:sizedPizzas,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(unknownSize),false);
 assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(unknownSize,initialUnknownSize).requiredTools.includes("sendMenuLink"));
 assert.equal((await createSendMenuLinkSkill(unknownSize).execute({reason:"unknown pizza size"}) as any).allowed,false);
 const burgers=[
  {name:"Бургер",category_name:"Бургеры",price:1200,available:true},
  {name:"Чизбургер",category_name:"Бургеры",price:1500,available:true},
 ];
 const burgerDecision=(text:string)=>currentGroundedCatalogCheckoutDecision(ctx(text,{
  menuSnapshot:{items:burgers,source:"live"},
  menuGrounding:{lookup_query:"бургеры",items:burgers},
 }));
 assert.equal(burgerDecision("Хочу Чизбургер. Не хочу бургеры."),false);
 assert.equal(burgerDecision("Хочу Чизбургер. Бургеры керек емес."),false);
 assert.equal(burgerDecision("Хочу Чизбургер. Бургерлер керек емес."),false);
 assert.equal(burgerDecision("Хочу Чизбургер. Не хочу никаких бургеров."),false);
 assert.equal(burgerDecision("Хочу Чизбургер. Я не хочу бургеров."),false);
 assert.equal(burgerDecision("Хочу Чизбургер. Не хочу никаких бургеров, особенно Бургер."),false);
 assert.equal(burgerDecision("Хочу Чизбургер. Бургерлер керек емес, әсіресе Бургер."),false);
 assert.equal(burgerDecision("Хочу Чизбургер. Не хочу Бургер."),true);
 const crossCategory=[
  {name:"Пепперони",category_name:"Пиццы",price:2000,available:true},
  {name:"Маргарита",category_name:"Пиццы",price:1800,available:true},
  {name:"Айран",category_name:"Напитки",price:500,available:true},
 ];
 const crossCategoryContext=ctx("Хочу Пепперони. Не хочу пицц и Айран.",{
  menuSnapshot:{items:crossCategory,source:"live"},
  menuGrounding:{lookup_query:"пиццы айран",items:crossCategory},
 });
 assert.equal(currentGroundedCatalogCheckoutDecision(crossCategoryContext),false);
 assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(crossCategoryContext,policy.resolveAgentToolPlan(crossCategoryContext)).requiredTools.includes("sendMenuLink"));
 assert.equal((await createSendMenuLinkSkill(crossCategoryContext).execute({reason:"declined category with cross-category item"}) as any).allowed,false);
 const lonePie=[{name:"Пирог Вектор",category_name:"Выпечка",price:1300,available:true}];
 for(const text of [
  "Хочу Пирог Комета.",
  "Пирог Вектор не хочу. Хочу Пирог Комета.",
  "Сколько стоит Пирог Вектор? Хочу Пирог Комета.",
 ]){
  const unknownPie=ctx(text,{menuSnapshot:{items:lonePie,source:"preview"}});
  const initialUnknownPie=policy.resolveAgentToolPlan(unknownPie);
  await groundMenuTurn(unknownPie,(async()=>({items:lonePie,source:"live"})) as any);
  assert.equal(currentGroundedCatalogCheckoutDecision(unknownPie),false,text);
  assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(unknownPie,initialUnknownPie).requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(unknownPie).execute({reason:"unknown lexical variant"}) as any).allowed,false,text);
 }
 const namedPizzas=[
  {name:"Пицца Вектор",category_name:"Пицца",price:2200,available:true},
  {name:"Пицца Милана",category_name:"Пицца",price:2400,available:true},
 ];
 const exactInflectedRefusal=ctx("Хочу Пицца Вектор. Не хочу пиццу Милана.",{
  menuSnapshot:{items:namedPizzas,source:"preview"},
 });
 const initialExactInflected=policy.resolveAgentToolPlan(exactInflectedRefusal);
 await groundMenuTurn(exactInflectedRefusal,(async()=>({items:namedPizzas,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(exactInflectedRefusal),true);
 assert.ok(policy.refreshAgentToolPlanAfterMenuGrounding(exactInflectedRefusal,initialExactInflected).requiredTools.includes("sendMenuLink"));
 assert.equal((await createSendMenuLinkSkill(exactInflectedRefusal).execute({reason:"remaining exact choice"}) as any).allowed,true);
 const exactSiblingSuffix=ctx("Хочу Пицца Вектор Милана.",{menuSnapshot:{items:namedPizzas,source:"preview"}});
 const initialExactSiblingSuffix=policy.resolveAgentToolPlan(exactSiblingSuffix);
 await groundMenuTurn(exactSiblingSuffix,(async()=>({items:namedPizzas,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(exactSiblingSuffix),false);
 assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(exactSiblingSuffix,initialExactSiblingSuffix).requiredTools.includes("sendMenuLink"));
 assert.equal((await createSendMenuLinkSkill(exactSiblingSuffix).execute({reason:"cross-SKU suffix"}) as any).allowed,false);
 const bothKnown=ctx("Хочу Пицца Вектор и Пицца Милана.",{menuSnapshot:{items:namedPizzas,source:"preview"}});
 await groundMenuTurn(bothKnown,(async()=>({items:namedPizzas,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(bothKnown),true);
 const crossSkuCatalog=[
  {name:"Донер",category_name:"Донеры",price:1800,available:true},
  {name:"Салат Комета",category_name:"Салаты",price:1600,available:true},
 ];
 for(const text of ["Хочу Донер Комета.","Донер не хочу. Хочу Донер Комета."]){
  const crossSkuSuffix=ctx(text,{menuSnapshot:{items:crossSkuCatalog,source:"preview"}});
  const initialCrossSkuSuffix=policy.resolveAgentToolPlan(crossSkuSuffix);
  await groundMenuTurn(crossSkuSuffix,(async()=>({items:crossSkuCatalog,source:"live"})) as any);
  assert.equal(currentGroundedCatalogCheckoutDecision(crossSkuSuffix),false,text);
  assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(crossSkuSuffix,initialCrossSkuSuffix).requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(crossSkuSuffix).execute({reason:"cross-category suffix"}) as any).allowed,false,text);
 }
 for(const text of ["Хочу Пицца Вектор сейчас.","Хочу Пицца Вектор с собой."]){
  const ordinaryModifier=ctx(text,{menuSnapshot:{items:namedPizzas,source:"preview"}});
  const initialOrdinaryModifier=policy.resolveAgentToolPlan(ordinaryModifier);
  await groundMenuTurn(ordinaryModifier,(async()=>({items:namedPizzas,source:"live"})) as any);
  assert.equal(currentGroundedCatalogCheckoutDecision(ordinaryModifier),true,text);
  assert.ok(policy.refreshAgentToolPlanAfterMenuGrounding(ordinaryModifier,initialOrdinaryModifier).requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(ordinaryModifier).execute({reason:"ordinary modifier"}) as any).allowed,true,text);
 }
 const unsupportedCustomization=ctx("Хочу Пицца Вектор с сыром.",{menuSnapshot:{items:namedPizzas,source:"preview"}});
 await groundMenuTurn(unsupportedCustomization,(async()=>({items:namedPizzas,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(unsupportedCustomization),false);
 const rollMenu=[
  {name:"Роллы Филадельфия",category_name:"Роллы",price:2600,available:true},
  {name:"Роллы Калифорния",category_name:"Роллы",price:2300,available:true},
 ];
 for(const [language,text] of [["ru","Хочу Роллы Филадельфия. Не хочу Роллы Калифорния."],["kk","Хочу Пицца Вектор. Пиццаны Милана қаламаймын."]] as const){
  const live=language==="kk"?namedPizzas:rollMenu;
  const exactItemRefusal=ctx(text,{language,menuSnapshot:{items:live,source:"preview"}});
  const initialExactItemRefusal=policy.resolveAgentToolPlan(exactItemRefusal);
  await groundMenuTurn(exactItemRefusal,(async()=>({items:live,source:"live"})) as any);
  assert.equal(currentGroundedCatalogCheckoutDecision(exactItemRefusal),true,text);
  assert.ok(policy.refreshAgentToolPlanAfterMenuGrounding(exactItemRefusal,initialExactItemRefusal).requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(exactItemRefusal).execute({reason:"separate exact item refusal"}) as any).allowed,true,text);
 }
 const oneRollRefused=ctx("Хочу роллы. Не хочу Роллы Филадельфия.",{menuSnapshot:{items:rollMenu,source:"preview"}});
 await groundMenuTurn(oneRollRefused,(async()=>({items:rollMenu,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(oneRollRefused),true);
 const allRollsRefused=ctx("Хочу Роллы Филадельфия. Не хочу роллы.",{menuSnapshot:{items:rollMenu,source:"preview"}});
 await groundMenuTurn(allRollsRefused,(async()=>({items:rollMenu,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(allRollsRefused),false);
 const drinkMenu=[
  {name:"Айран",category_name:"Напитки",price:500,available:true},
  {name:"Лимонад",category_name:"Напитки",price:700,available:true},
 ];
 const combinedRefusal=ctx("Хочу Айран. Напитки не хочу, Айран тоже.",{menuSnapshot:{items:drinkMenu,source:"preview"}});
 const initialCombinedRefusal=policy.resolveAgentToolPlan(combinedRefusal);
 await groundMenuTurn(combinedRefusal,(async()=>({items:drinkMenu,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(combinedRefusal),false);
 assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(combinedRefusal,initialCombinedRefusal).requiredTools.includes("sendMenuLink"));
 assert.equal((await createSendMenuLinkSkill(combinedRefusal).execute({reason:"combined category and item refusal"}) as any).allowed,false);
 for(const text of [
  "Хочу Пицца Небула.",
  "Хочу Пицца Вектор Небула.",
  "Хочу Пицца Вектор XL.",
  "Хочу Пицца Вектор. Нет, хочу Пицца Небула.",
  "Пицца Небула керек.",
 ]){
  const unknownNamedPizza=ctx(text,{menuSnapshot:{items:namedPizzas,source:"preview"}});
  const initialUnknownNamedPizza=policy.resolveAgentToolPlan(unknownNamedPizza);
  await groundMenuTurn(unknownNamedPizza,(async()=>({items:namedPizzas,source:"live"})) as any);
  assert.equal(currentGroundedCatalogCheckoutDecision(unknownNamedPizza),false,text);
  assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(unknownNamedPizza,initialUnknownNamedPizza).requiredTools.includes("sendMenuLink"),text);
  assert.equal((await createSendMenuLinkSkill(unknownNamedPizza).execute({reason:"unknown named pizza"}) as any).allowed,false,text);
 }
 const doners=[
  {name:"Донер с курицей",category_name:"Донеры",price:1600,available:true},
  {name:"Донер с говядиной",category_name:"Донеры",price:1800,available:true},
 ];
 const numericGeneric=ctx("2 донера возьму.",{menuSnapshot:{items:[{name:"Донер куриный",price:1800,available:true}],source:"preview"}});
 const initialNumericGeneric=policy.resolveAgentToolPlan(numericGeneric);
 await groundMenuTurn(numericGeneric,(async()=>({items:[{name:"Донер куриный",price:1800,available:true}],source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(numericGeneric),true);
 assert.ok(policy.refreshAgentToolPlanAfterMenuGrounding(numericGeneric,initialNumericGeneric).requiredTools.includes("sendMenuLink"));
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Донер с курицей. Не хочу донеры.",{
  menuSnapshot:{items:doners,source:"live"},
  menuGrounding:{lookup_query:"донеры",items:doners},
 })),false);
 const codeMenu=[{name:"Сет XL",category_name:"Сеты",price:2500,available:true}];
 for(const code of ["XS","X","AB","XXL"]){
  const unknown=ctx("Хочу Сет "+code+".");
  await groundMenuTurn(unknown,(async()=>({items:codeMenu,source:"live"})) as any);
  assert.equal(currentGroundedCatalogCheckoutDecision(unknown),false,code);
  assert.ok(!policy.refreshAgentToolPlanAfterMenuGrounding(unknown,policy.resolveAgentToolPlan(unknown)).requiredTools.includes("sendMenuLink"),code);
 }
 const knownCode=ctx("Хочу Сет XL.");
 await groundMenuTurn(knownCode,(async()=>({items:codeMenu,source:"live"})) as any);
 assert.equal(currentGroundedCatalogCheckoutDecision(knownCode),true);
 const collision=[
  {name:"Напитки",category_name:"Напитки",price:600,available:true},
  {name:"Айран",category_name:"Напитки",price:500,available:true},
 ];
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Хочу Айран. Напитки не хочу.",{
  menuSnapshot:{items:collision,source:"live"},
  menuGrounding:{lookup_query:"напитки",items:collision},
 })),false);
 const singularCollision=[
  {name:"Бургер",category_name:"Бургер",price:1200,available:true},
  {name:"Чизбургер",category_name:"Бургер",price:1500,available:true},
 ];
 assert.equal(currentGroundedCatalogCheckoutDecision(ctx("Хочу Чизбургер. Не хочу Бургер.",{
  menuSnapshot:{items:singularCollision,source:"live"},
  menuGrounding:{lookup_query:"бургер",items:singularCollision},
 })),true);
 const mixed=ctx("Айран алайын. Сусындар керек емес.",{language:"kk",menuSnapshot:{items:live,source:"live"}});
 await groundMenuTurn(mixed,(async()=>({items:live,source:"live"})) as any);
 const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(mixed,policy.resolveAgentToolPlan(mixed));
 assert.ok(!refreshed.requiredTools.includes("sendMenuLink"));
 assert.equal((await createSendMenuLinkSkill(mixed).execute({reason:"declined mixed-language category"}) as any).allowed,false);
});


test("live grounding preserves independent exact SKUs instead of choosing the globally longest name",async()=>{
 const live=[
  {name:"Айран",category_name:"Напитки",price:500,available:true},
  {name:"Пирог Орбита",category_name:"Выпечка",price:1500,available:false},
 ];
 const c=ctx("Хочу Айран и Пирог Орбита.",{menuSnapshot:{items:live,source:"live"}});
 const out:any=await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
 assert.deepEqual(out.items.map((item:any)=>item.name),["Айран"]);
 const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c));
 assert.ok(refreshed.requiredTools.includes("sendMenuLink"));
});

test("numeric catalog identity cannot borrow permission from a numbered sibling",()=>{
 for(const [blockedName,allowedName,text] of [
  ["Пицца 30","Пицца 40","Хочу Пицца 30."],
  ["Пицца30","Пицца40","Хочу Пицца30."],
 ] as const){
  const live=[
   {name:blockedName,category_name:"Пиццы",price:2500,available:false},
   {name:allowedName,category_name:"Пиццы",price:2600,available:true},
  ];
  assert.equal(currentGroundedCatalogCheckoutDecision(ctx(text,{menuSnapshot:{items:live,source:"live"},menuGrounding:{lookup_query:text,items:[live[1]]}})),false,text);
 }
});


test("semantic category aliases never become exact SKU identity",async()=>{
 for(const [blockedName,allowedName,text] of [
  ["Тауық","Курица","Тауық алайын."],
  ["Ірімшік","Сыр","Ірімшік алайын."],
  ["Сыр","Сырники","Хочу Сыр."],
  ["Пицца XL","Пицца L","Хочу Пицца XL."],
  ["Набор A1","Набор B2","Хочу Набор A1."],
  ["Моко","Мока","Хочу Моко."],
  ["Пицца Милана","Пицца Милан","Хочу Пицца Милана."],
  ["Сет «A1»","Сет «A2»","Хочу Сет A1."],
  ["Пицца «Орбита»","Пицца «Вектор»","Хочу Пицца Орбита."],
 ] as const){
  const live=[
   {name:blockedName,category_name:"Основное",price:1500,available:false},
   {name:allowedName,category_name:"Основное",price:1600,available:true},
  ];
  const c=ctx(text,{menuSnapshot:{items:live,source:"live"}});
  const out:any=await groundMenuTurn(c,(async()=>({items:live,source:"live"})) as any);
  assert.equal(out.items.length,0,text);
  assert.equal(currentGroundedCatalogCheckoutDecision(c),false,text);
  const refreshed=policy.refreshAgentToolPlanAfterMenuGrounding(c,policy.resolveAgentToolPlan(c));
  assert.ok(!refreshed.requiredTools.includes("sendMenuLink"),text);
 }
});

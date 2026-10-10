import assert from "node:assert/strict";
import test from "node:test";
process.env.REDIS_URL="redis://127.0.0.1:1";process.env.REDIS_CONNECT_TIMEOUT_MS="100";process.env.REDIS_OPERATION_TIMEOUT_MS="100";
const budget=await import("../src/utils/menuBudget.js");
const {menuLinkDecisionForTurn}=await import("../src/utils/magicLink.js");
const {isCurrentPaymentDetailsIntent}=await import("../src/utils/paymentIntent.js");
const policy=await import("../src/agent/toolPolicy.js");
const {createSendMenuLinkSkill}=await import("../src/skills/menuLink.skill.js");
const {groundMenuTurn,pageMenuMatches}=await import("../src/skills/searchMenu.skill.js");
const {validateFinalText}=await import("../src/agent/finalValidator.js");
const {redisClient}=await import("../src/services/redis.service.js");
test.after(()=>{if(redisClient.isOpen)redisClient.destroy();});
const open={runtime_available:true,live:true,is_accepting_orders:true,within_work_hours:true,is_emergency:false,wait_time:0};
const menu=[
{name:"Цезарь авторский",category_name:"Салаты",price:2300,available:true},{name:"Тёплый салат",category_name:"Салаты",price:2700,available:true},
{name:"Стейк Рибай",category_name:"Стейки",price:2450,available:true},{name:"Стейк Большой",category_name:"Стейки",price:3100,available:true},
{name:"Самса үй",category_name:"Бәліштер",price:900,available:true},{name:"Қаттама үй",category_name:"Бәліштер",price:2600,available:true},
{name:"Донер дешёвый",category_name:"Донеры",price:800,available:true}];
const ctx=(text:string,extra:any={})=>({instanceId:"final-revision",phone:"77000000001",text,senderMeta:{},language:"ru",languagePolicy:{},config:{domain:"https://fixture.invalid"},runtimeStatus:open,hardRealtimeContext:open,fetchedSettings:{},activeOrder:null,chatHistory:[],menuSnapshot:{items:menu,source:"live"},menuGrounding:undefined,activeShiftNotes:[],activeShiftNotesFingerprint:"",mediaContext:null,shporContext:[],magicLinkAlreadySent:false,magicLinkGranted:false,explicitMenuLinkIntent:false,magicLink:"https://fixture.invalid/order",...extra} as any);

test("arbitrary categories are budget inquiries without dish hardcode",()=>{
for(const text of ["Какие салаты до 2500?","Какие стейки до 2500?","2500 теңгеге дейін қандай бәліштер бар?"]){assert.equal(budget.isMenuBudgetInquiry(text),true,text);assert.equal(budget.getMenuBudgetInquiry(text),2500,text);assert.ok(policy.resolveAgentToolPlan(ctx(text)).requiredTools.includes("searchMenu"),text);}
for(const text of ["Я оплатил 2500 тенге","Перевёл 2500 тг","Доставка стоит 2500 тг?","Какие реквизиты для оплаты 2500 тг?","Возьму салат за 2500 тг","2500 теңгеге стейкке тапсырыс беремін"])assert.equal(budget.isMenuBudgetInquiry(text),false,text);
});

test("budget choices stay inside current grounded category",()=>{
for(const [text,language,items,expected,forbidden] of [["Какие салаты до 2500?","ru",[menu[0]],/Цезарь авторский/u,/Донер дешёвый|Стейк Рибай/u],["2500 теңгеге дейін қандай бәліштер бар?","kk",[menu[4]],/Самса үй/u,/Донер дешёвый|Цезарь авторский/u]] as const){const c=ctx(text,{language,menuGrounding:{menu_lookup:"live",lookup_query:text,items,totalMatched:items.length}});const r=validateFinalText("Проверяю.",c,{toolsCalled:["searchMenu"]});assert.match(r.text,expected,text);assert.doesNotMatch(r.text,forbidden,text);assert.doesNotMatch(r.text,/2700|2600|3100/u,text);}
});

test("budget answer preserves closed and wait policy",()=>{
const closed={...open,is_accepting_orders:false,is_emergency:true},waiting={...open,wait_time:90};
for(const [language,runtime,draft,must] of [["ru",closed,"Кухня сейчас закрыта.",/кухня сейчас закрыта/iu],["kk",closed,"Асүй қазір жабық.",/асүй қазір жабық/iu],["ru",waiting,"Ожидание около 90 минут. Сможете подождать?",/90 минут.*подождать/iu],["kk",waiting,"Күту уақыты шамамен 90 минут. Күте аласыз ба?",/90 минут.*күте аласыз/iu]] as const){const c=ctx(language==="ru"?"Какие салаты до 2500?":"2500 теңгеге дейін қандай бәліштер бар?",{language,runtimeStatus:runtime,hardRealtimeContext:runtime,menuGrounding:{menu_lookup:"live",items:[menu[0],menu[4]]}});const r=validateFinalText(draft,c,{toolsCalled:["searchMenu","getKitchenStatus"]});assert.match(r.text,must);assert.doesNotMatch(r.text,/Цезарь авторский|Самса үй/u);}
});

test("menu-link decision has no middle gap and fails closed over limit",()=>{
const fill="а".repeat(2200);
assert.equal(menuLinkDecisionForTurn("Пришлите ссылку. "+fill+". Ссылку не присылай. "+fill),"deny");
assert.equal(menuLinkDecisionForTurn("Ссылку не присылай. "+fill+". Пришлите ссылку. "+fill),"allow");
assert.equal(menuLinkDecisionForTurn(fill+". Сілтемені жібермеңіз. "+fill),"deny");
assert.equal(menuLinkDecisionForTurn(fill+". Сілтемені жіберіңіз. "+fill),"allow");
assert.equal(menuLinkDecisionForTurn("Пришлите ссылку. "+"а".repeat(9000)),"deny");
assert.equal(menuLinkDecisionForTurn("Какие салаты? "+"а".repeat(9000)+". Нет, пришлите ссылку."),"deny");
assert.equal(menuLinkDecisionForTurn("Какие салаты? "+"а".repeat(9000)),"deny");
});

test("blocked bare availability is corrected without note leakage",()=>{
const items=[{name:"Пицца Маргарита",category_name:"Пиццы",price:2100,available:true},{name:"Пепперони",category_name:"Пиццы",price:2300,available:false},{name:"Сырная",category_name:"Пиццы",price:2400,available:true}];
const base={menuSnapshot:{items,source:"live"},menuGrounding:{menu_lookup:"live",items:[items[2]],sold_out_now:["Пепперони"]},activeShiftNotes:[{text:"Пицца Маргарита жоқ",createdAt:Date.now()}]};
for(const [language,raw] of [["ru","Пицца Маргарита есть."],["kk","Пицца Маргарита бар."],["ru","Пепперони есть."],["kk","Пепперони бар."],["ru","Пицца Маргарита — 2100 тг."],["kk","Пепперони — 2300 тг."]] as const){const r=validateFinalText(raw,ctx("Какие пиццы есть?",{...base,language}),{toolsCalled:["searchMenu"]});assert.doesNotMatch(r.text,/2100|2300/u,raw);assert.match(r.text,language==="kk"?/қолжетімсіз|жоқ/iu:/недоступ/iu,raw);assert.doesNotMatch(r.text,/заметк|оператор|жазылған/iu,raw);}
for(const raw of ["Пицца Маргарита есть?","Клиент написал: «Пицца Маргарита есть.»","Вчера Пицца Маргарита была в наличии.","Кеше Пицца Маргарита бар еді."])assert.equal(validateFinalText(raw,ctx("Повторите факт",base),{toolsCalled:["searchMenu"]}).text,raw);
});

test("payment events are not payment-details requests",async()=>{
for(const text of ["Я оплатил","Я уже оплатил заказ","Оплата прошла?","Мен төледім","Төлем өтті ме?"]){const c=ctx(text);assert.equal(isCurrentPaymentDetailsIntent(text),false,text);assert.ok(!policy.resolveAgentToolPlan(c).requiredTools.includes("getPaymentDetails"),text);assert.equal((await createSendMenuLinkSkill(c).execute({reason:"payment event"}) as any).allowed,false,text);}
for(const text of ["Пришлите реквизиты оплаты","Kaspi-ге қалай төлеймін?","Қай шотқа төлем жасаймын?"]){const c=ctx(text);assert.equal(isCurrentPaymentDetailsIntent(text),true,text);assert.ok(policy.resolveAgentToolPlan(c).requiredTools.includes("getPaymentDetails"),text);assert.equal((await createSendMenuLinkSkill(c).execute({reason:"payment details"}) as any).allowed,false,text);}
});

test("unseen preview category searches before link and refreshes",async()=>{
for(const [text,category,language] of [["А выпечка?","Выпечка","ru"],["Ал бәліштер?","Бәліштер","kk"]] as const){const preview=Array.from({length:60},(_,i)=>({name:"Пицца "+i,category_name:"Пиццы",price:1000+i,available:true}));const unseen=[{name:category+" A",category_name:category,price:900,available:true},{name:category+" B",category_name:category,price:1100,available:true}];const c=ctx(text,{language,menuSnapshot:{items:preview,source:"preview"}});const initial=policy.resolveAgentToolPlan(c);assert.ok(initial.requiredTools.includes("searchMenu"),text);assert.ok(!initial.requiredTools.includes("sendMenuLink"),text);await groundMenuTurn(c,(async()=>({items:[...preview,...unseen],source:"live"})) as any);assert.ok(policy.refreshAgentToolPlanAfterMenuGrounding(c,initial).requiredTools.includes("sendMenuLink"),text);}
});

test("unrelated short turns gain no catalog authority",()=>{for(const text of ["А доставка?","А оплата?","А оператор?","Как дела?","Спасибо?","А заказ?"]){const p=policy.resolveAgentToolPlan(ctx(text));assert.ok(!p.requiredTools.includes("sendMenuLink"),text);assert.ok(!p.requiredTools.includes("escalateToAdmin"),text);assert.ok(!p.requiredTools.includes("searchMenu"),text);}});

test("paging totals deduplicate public SKU names before slicing",()=>{const unique=Array.from({length:61},(_,i)=>({name:"Позиция "+(i+1),category_name:"Выпечка",price:1000+i,available:true}));const page=pageMenuMatches([...unique.slice(0,60),{...unique[0]},unique[60]],50,0);assert.equal(page.totalMatched,61);assert.equal(page.nextOffset,50);});

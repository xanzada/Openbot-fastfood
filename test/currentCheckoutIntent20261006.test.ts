import test from "node:test";
import assert from "node:assert/strict";
process.env.REDIS_URL="redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS="500";
process.env.REDIS_OPERATION_TIMEOUT_MS="500";
const {hasCustomerCheckoutIntent}=await import("../src/utils/orderIntent.js");
const {resolveAgentToolPlan}=await import("../src/agent/toolPolicy.js");
const {createSendMenuLinkSkill}=await import("../src/skills/menuLink.skill.js");
const {redisClient}=await import("../src/services/redis.service.js");
test.after(()=>{if(redisClient.isOpen)redisClient.destroy();});
const positive=["Мәзірді осында жіберіңіз.","Мәзірді осында жазып жіберіңіз. Сілтемені жіберіңіз.","Меню напишите здесь, и пришлите ссылку.","Напишите меню здесь и скиньте ссылку.","Мәзірді жазып беріңіз, екі донер алайын.","Мәзірді және 2 донердің бағасын көрсетіңіз","Покажите меню и цену 2 донеров.","Хочу заказать 2 донера, сколько стоят?","2 донер","Мәзірді жіберіңіз, бұрын оператор жіберген.","Отправьте меню, оператор раньше прислал ссылку.","Мәзірді жіберіңіз.","Себетті ашып бер.","Не хочу заказ. Пришлите ссылку.","Не отправляйте меню, но откройте корзину.","Себетті ашпаңыз. Мәзірді жіберіңіз.","Каталогты көрсетпеңіз! Бірақ себетті ашып беріңіз.","Тапсырыс бермеймін, бірақ сілтемені жіберіңіз.","Мәзірді жібермеңіз, себетті ашып бер.","Отправьте меню для заказа","Пришлите ссылку","себетті ашып бер","каталогты көрсетші","Хочу сделать заказ","Откройте корзину","Где оформить заказ?"];
const negative=["Мәзірді осында жазып жіберіңіз.","Мәзірді чатта мәтінмен жіберіңіз.","Напишите меню здесь и отправьте.","Покажите меню текстом.","Пришлите меню списком.","Меню жіберіңіз мәтінмен.","Напишите меню здесь, вместо ссылки.","2 донера есть?","Покажите цену 2 пицц.","2 донердің бағасын көрсетіңіз.","Покажите фото 2 пицц.","Есть ли 2 донера?","2 донер бар ма?","2 донера, сколько стоят?","2 донер, бағасы қанша?","2 пиццы. Сколько стоят?","2 донера сколько стоят?","2 донер қанша тұрады?","Сколько стоят 2 пиццы?","Оператор мәзірді жіберді.","Оператор отправил мне ссылку.","Себетті кеше аштым.","Меню вчера показывали.","Клиент написал «Отправьте меню»","Мәзірді жібермеңіз.","Сілтемені жібермеңіз.","Себетті ашпаңыз.","Каталогты көрсетпеңіз.","Мәзірді жіберіңіз, бірақ сілтемені жібермеңіз.","Пришлите ссылку, но меню не отправляйте.","Мәзірді жібермеңіз, бірақ донердің бағасын айтыңыз.","Не присылайте ссылку; просто покажите цену донера.","Не отправляйте, пожалуйста, меню.","Клиент «Мәзірді жіберіңіз» деп жазды.","Не отправляйте меню","Не присылайте ссылку","Меню не отправляйте","Кола бар ма?","Донер қанша тұрады?","Что есть в меню?","Сколько стоит корзина?","Хочу узнать цену","Не хочу сделать заказ","Не хочу оформить заказ","Не заказываю","Не открывайте корзину","Не показывайте каталог","Клиент написал «Откройте корзину»"];
const ctx=(text:string,extra:any={})=>({instanceId:"checkout-synthetic",phone:"77000000001",text,language:"ru",config:{},fetchedSettings:{},activeOrder:null,activeShiftNotes:[],menuSnapshot:{items:[]},runtimeStatus:{is_accepting_orders:true,within_work_hours:true,wait_time:0},hardRealtimeContext:{runtime_available:true},magicLink:"https://fixture.invalid/menu",explicitMenuLinkIntent:false,magicLinkAlreadySent:false,...extra} as any);
for(const text of positive){
 test("current checkout request pins and grants link: "+text,async()=>{
  const c=ctx(text);
  assert.equal(hasCustomerCheckoutIntent(text),true);
  assert.ok(resolveAgentToolPlan(c).requiredTools.includes("sendMenuLink"));
  const result:any=await createSendMenuLinkSkill(c).execute({reason:"actual customer request"});
  assert.equal(result.allowed,true);assert.equal(result.link,c.magicLink);
  assert.equal(c.magicLinkGranted,true);
 });
}
for(const text of negative){
 test("no checkout grant from an ordinary, denied or quoted request: "+text,async()=>{
  const c=ctx(text,{explicitMenuLinkIntent:true});
  assert.equal(hasCustomerCheckoutIntent(text),false);
  assert.equal(resolveAgentToolPlan(c).requiredTools.includes("sendMenuLink"),false);
  const result:any=await createSendMenuLinkSkill(c).execute({reason:"model claims customer asked",guestAskedToResend:true});
  assert.equal(result.allowed,false);assert.equal(result.link,null);
  assert.equal(result.reason,"link_not_requested");
  assert.notEqual(c.magicLinkGranted,true);
 });
}
test("a current cart request preserves actual kitchen closure",async()=>{
 const c=ctx("Откройте корзину",{runtimeStatus:{is_accepting_orders:false,within_work_hours:true,wait_time:240}});
 const result:any=await createSendMenuLinkSkill(c).execute({reason:"actual customer request"});
 assert.equal(result.allowed,false);assert.equal(result.reason,"kitchen_closed");
});

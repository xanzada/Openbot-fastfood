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
const positive=["Отправьте меню для заказа","Пришлите ссылку","себетті ашып бер","каталогты көрсетші","Хочу сделать заказ","Откройте корзину","Где оформить заказ?"];
const negative=["Не отправляйте меню","Не присылайте ссылку","Меню не отправляйте","Кола бар ма?","Донер қанша тұрады?","Что есть в меню?","Сколько стоит корзина?","Хочу узнать цену","Не хочу сделать заказ","Не хочу оформить заказ","Не заказываю","Не открывайте корзину","Не показывайте каталог","Клиент написал «Откройте корзину»"];
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

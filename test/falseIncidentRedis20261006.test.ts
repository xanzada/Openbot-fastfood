import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {redisClient,connectRedis} from "../src/services/redis.service.js";
import {routeComplaintToAdmin} from "../src/services/complaintRouting.service.js";
const enabled=process.env.AUDIT_REDIS_INTEGRATION==="1";
const owned:string[]=[];
for(const [text,source] of [
 ["Согласен ждать 60 минут","ai_tool_escalate_to_admin"],
 ["Кола бар ма?","ai_tool_escalate_to_admin"],
 ["Согласен ждать 60 минут","complaint_text"],
 ["Согласен ждать 60 минут","planned_escalation_missed"],
 ["Не хочу говорить с оператором","ai_tool_escalate_to_admin"],
 ["Не хочу говорить с оператором","ai_unavailable"],
 ["Оператор сказал, что нужно добавить сыр","human_request"],
 ["Не отменяйте мой заказ, всё нормально","cancel_request"],
 ["Возврат не нужен, заказ нормальный","ai_tool_escalate_to_admin"],
 ["Аллергии нет, хочу колу","ai_tool_escalate_to_admin"],
 ["Не вызывайте скорую, я спросил цену","ai_tool_escalate_to_admin"],
 ["[Media sent]","long_voice"],
] as const) {
 test("real Redis preserves pending state without case/marker/notification for "+source+": "+text,{skip:!enabled},async()=>{
  await connectRedis();
  const instanceId="audit-false-incident-"+crypto.randomUUID(),phone="77000000000";
  const pending="complaint_clarify:"+instanceId+":"+phone;owned.push(pending);
  await redisClient.set(pending,"У меня жалоба",{EX:600});
  const before:string[]=[];for await(const rows of redisClient.scanIterator({MATCH:"*"+instanceId+"*"})){before.push(...(Array.isArray(rows)?rows:[rows]));}
  const result=await routeComplaintToAdmin({
   instanceId,phone,text,language:"ru",config:{},
   thinking:{risk:"high",mood:"angry"},chatHistory:[{role:"assistant",content:"У клиента аллергия, нужен оператор"}],
  } as any,{summary:"Модель заявила конфликт",customerText:"У меня жалоба — "+text,urgency:"high",source,customerReply:"Передал оператору, он свяжется"});
  assert.equal(result.caseId,null);assert.equal(result.operatorFlagged,false);assert.equal(result.queuedForChat,false);
  assert.match(result.action,/^skipped_/);
  assert.doesNotMatch(result.customerReply||"",/Передал|свяжется/iu);
  const after:string[]=[];for await(const rows of redisClient.scanIterator({MATCH:"*"+instanceId+"*"})){after.push(...(Array.isArray(rows)?rows:[rows]));}
  assert.deepEqual(after.sort(),before.sort(),"no canonical case/SOS/notification or new pending keys");
  assert.equal(await redisClient.get(pending),"У меня жалоба","old pending complaint cannot be consumed by unrelated input");
 });
}
test.after(async()=>{if(redisClient.isOpen){if(owned.length)await redisClient.del(owned);await redisClient.quit();}});

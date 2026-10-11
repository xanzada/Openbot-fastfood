import {createHash} from "node:crypto";
import type {FastFoodContext} from "../context/types.js";
import {getMenuBudgetInquiry, isMenuBudgetInquiry, isQualitativeMenuBudgetInquiry} from "../utils/menuBudget.js";
import {foldIntentText} from "../utils/intentText.js";
import {menuItemBlockedByNotes, menuVocabulary} from "./noteProvenance.service.js";

export const SHOPPING_SESSION_TTL_MS=30*60_000;
const SHOPPING_IO_TIMEOUT_MS=500;
async function boundedShoppingIO<T>(operation:Promise<T>,timeoutMs:number):Promise<T>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([operation,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("SHOPPING_STATE_TIMEOUT")),timeoutMs);})]);}
 finally{if(timer!==undefined)clearTimeout(timer);}
}

export interface ShoppingConstraints {
 schema:"SHOPPING_SESSION_V1";tenant:string;customerScope:string;startedAt:number;
 revision:number;budget:number|null;avoidMeat:boolean;uncertainBudget:boolean;expiresAt:number;
}
export interface ShoppingItem {id?:unknown;name?:unknown;price?:unknown;composition?:unknown;description?:unknown;available?:unknown;category_name?:unknown;[key:string]:unknown}
const visible=(text:unknown)=>String(text||"").replace(/«[^»]*»|“[^”]*”|"[^"]*"|‘[^’]*’|'[^']*'/gu,"");
const scope=(ctx:Pick<FastFoodContext,"phone">)=>createHash("sha256").update(String(ctx.phone||"").replace(/\D/g,"")).digest("hex");
export function shoppingSessionKey(ctx:Pick<FastFoodContext,"instanceId"|"phone">){return "shopping_constraints:v1:"+encodeURIComponent(ctx.instanceId)+":"+scope(ctx);}
function valid(value:unknown,ctx:FastFoodContext,now:number):value is ShoppingConstraints {
 if(!value||typeof value!=="object")return false;
 const s=value as ShoppingConstraints;
 return s.schema==="SHOPPING_SESSION_V1"&&s.tenant===ctx.instanceId&&s.customerScope===scope(ctx)
  &&Number.isFinite(s.startedAt)&&s.startedAt<=now&&Number.isFinite(s.expiresAt)&&s.expiresAt>now&&s.expiresAt<=now+SHOPPING_SESSION_TTL_MS
  &&Number.isInteger(s.revision)&&s.revision>=0&&typeof s.avoidMeat==="boolean"&&typeof s.uncertainBudget==="boolean"
  &&(s.budget===null||Number.isSafeInteger(s.budget)&&s.budget>0&&s.budget<=1_000_000);
}
export function reduceShoppingConstraints(ctx:FastFoodContext,previous:unknown,now=Date.now()):ShoppingConstraints {
 const prior=valid(previous,ctx,now)?previous:null;
 const s:ShoppingConstraints=prior?{...prior}:{schema:"SHOPPING_SESSION_V1",tenant:ctx.instanceId,customerScope:scope(ctx),startedAt:now,revision:0,budget:null,avoidMeat:false,uncertainBudget:false,expiresAt:now+SHOPPING_SESSION_TTL_MS};
 const text=visible(ctx.text);const folded=foldIntentText(text);
 if(/(?:новый\s+заказ|начнем\s+заново|сбрось\s+(?:все\s+)?огранич|жан[ағ]\s+тапсырыс|кайта\s+бастай)/iu.test(folded)){s.budget=null;s.avoidMeat=false;s.uncertainBudget=false;s.startedAt=now;}
 if(/(?:бюджет[^.!?]{0,30}(?:не\s+огранич|не\s+важ|без\s+огранич)|сброс[^.!?]{0,20}бюджет|бюджет[^.!?]{0,20}шектеусиз)/iu.test(folded)){s.budget=null;s.uncertainBudget=false;}
 const budgetClause=text.split(/[.!?;\n]/u).find(clause=>/бюджет/iu.test(clause)&&/(?:увелич|подня|повыс|теперь|до\s+\d|котер|енди)/iu.test(foldIntentText(clause)));
 const ownedMoney=/(?:у\s+меня|менде|тенгем)(?!\p{L})/iu.test(folded)&&!/(?:заказ|тапсырыс|оплат|толем|чек|стоим|сумма)/iu.test(folded);
 const amount=budgetClause?getMenuBudgetInquiry("бюджет "+budgetClause):getMenuBudgetInquiry(ownedMoney?"бюджет "+text:text);
 const explicitAmountMention=/\d|(?<!\p{L})(?:тенге\p{L}*|тг|kzt|₸|мың|миллион)(?!\p{L})/iu.test(folded);
 if(amount!==null){s.budget=amount;s.uncertainBudget=false;}
 else if((isMenuBudgetInquiry(text)||budgetClause)&&(!isQualitativeMenuBudgetInquiry(text)||explicitAmountMention)){s.uncertainBudget=true;}
 const vegetarianRequest=/(?:^|[.!?;,]\s*)(?:я\s+вегетариан(?:ец|ка)(?!\p{L})|(?:(?:я|мне)\s+)?(?:хочу|нужно|нужны|дайте|предложите|посоветуйте)\s+вегетарианск(?:ое|ую|ие|ий)(?!\p{L})|вегетарианск(?:ое|ую|ие|ий)(?!\p{L}))/iu.test(folded);
 if(vegetarianRequest||/(?:без\s+мяса|не\s+ем\s+мяс|мясо\s+не\s+ем|(?<!\p{L})етсиз(?!\p{L})|ет\s+жемей)/iu.test(folded))s.avoidMeat=true;
 if(/(?:можно\s+с\s+мясом|мясо\s+(?:теперь\s+)?можно|теперь\s+ем\s+мяс|ет\s+жеймин|етти\s+болады)/iu.test(folded))s.avoidMeat=false;
 s.revision++;s.expiresAt=now+SHOPPING_SESSION_TTL_MS;return s;
}
/** Only customer messages from the current bounded session may seed a missing record. */
export function shoppingConstraintsForContext(ctx:FastFoodContext,now=Date.now()):ShoppingConstraints {
 if(valid(ctx.shoppingConstraints,ctx,now))return {...ctx.shoppingConstraints};
 let state:ShoppingConstraints|null=null;
 for(const row of (Array.isArray(ctx.chatHistory)?ctx.chatHistory:[]).slice(-40)){
  if(!row||row.role!=="user")continue;
  if(row.instanceId&&row.instanceId!==ctx.instanceId||row.instance_id&&row.instance_id!==ctx.instanceId)continue;
  if(row.phone&&String(row.phone).replace(/\D/g,"")!==String(ctx.phone).replace(/\D/g,""))continue;
  const at=typeof row.createdAt==="number"?row.createdAt:Date.parse(String(row.createdAt||""));
  if(!Number.isFinite(at)||at>now||at<=now-SHOPPING_SESSION_TTL_MS)continue;
  state=reduceShoppingConstraints({...ctx,text:String(row.text??row.content??row.body??"")},state,now);
 }
 return reduceShoppingConstraints(ctx,state,now);
}
/** Compact TTL state belongs to this conversation, never the long-term customer profile. */
export async function refreshShoppingConstraints(ctx:FastFoodContext,deps?:{read:(key:string)=>Promise<unknown>;write:(key:string,ttl:number,value:ShoppingConstraints)=>Promise<unknown>;timeoutMs?:number},now=Date.now()) {
 const key=shoppingSessionKey(ctx);
 const io:NonNullable<typeof deps>=deps||await import("./redis.service.js").then(({redisClient})=>({
  read:async(k:string)=>{if(!redisClient.isReady)throw new Error("SHOPPING_STATE_UNAVAILABLE");const raw=await redisClient.get(k);return raw?JSON.parse(raw):null;},
  write:async(k:string,ttl:number,value:ShoppingConstraints)=>{if(!redisClient.isReady)throw new Error("SHOPPING_STATE_UNAVAILABLE");return redisClient.setEx(k,ttl,JSON.stringify(value));}
 }));
 const timeoutMs=Number.isFinite(deps?.timeoutMs)?Math.max(1,Math.min(SHOPPING_IO_TIMEOUT_MS,deps!.timeoutMs!)):SHOPPING_IO_TIMEOUT_MS;
 let loaded:unknown=null;let unavailable=false;
 try{loaded=await boundedShoppingIO(io.read(key),timeoutMs);}catch{unavailable=true;}
 const base=valid(loaded,ctx,now)?loaded:shoppingConstraintsForContext({...ctx,text:""},now);
 const state=reduceShoppingConstraints(ctx,base,now);ctx.shoppingConstraints=state;
 ctx.shoppingStateUnavailable=unavailable;ctx.shoppingPriorStateUnknown=unavailable;
 if(unavailable)return state;
 // Timeout bounds waiting, not the issued Redis command. The singleton client sends commands FIFO.
 try{await boundedShoppingIO(io.write(key,SHOPPING_SESSION_TTL_MS/1000,state),timeoutMs);}catch{ctx.shoppingStateUnavailable=true;}
 return state;
}
export function isShoppingDecision(ctx:FastFoodContext):boolean {
 const text=foldIntentText(visible(ctx.text));
 if(/(?:оплат|чек|возврат|статус|где\s+заказ|заказ\s+(?:готов|принят)|тапсырыс[^.!?]{0,20}(?:кайда|дайын)|толем)/iu.test(text))return false;
 const named=(ctx.menuSnapshot?.items||[]).some((item:ShoppingItem)=>{const name=foldIntentText(String(item.name||"")).trim();return name&&text.includes(name);});
 const choice=/(?:посовет|рекоменд|подойдет|подходит|выбрат|усына|лайык)/iu.test(text);
 const compositionSubject=text.match(/(?:в\s+составе|состав|курам\p{L}*)\s+([\p{L}\s]{1,50})/iu)?.[1];
 const specificComposition=Boolean(compositionSubject&&(ctx.menuSnapshot?.items||[]).some((item:ShoppingItem)=>{
  const words=foldIntentText(String(item.name||"" )).match(/\p{L}{4,}/gu)||[];
  const asked=compositionSubject.match(/\p{L}{4,}/gu)||[];
  return words.some(word=>asked.some(subject=>subject===word||subject.startsWith(word)));
 }));
 if(specificComposition&&!choice)return false;
 const factualReference=/(?<!\p{L})(?:этот\s+вариант|это\s+комбо|это\s+блюдо|эта\s+позиция)(?!\p{L})/iu.test(text);
 if((named||factualReference)&&!choice&&/(?:сколько\s+стоит|цена|цен[ыу]|дороже|почему|состав|канша\s+турады|багасы|курам)/iu.test(text))return false;
 return isMenuBudgetInquiry(ctx.text)||/(?:посовет|рекоменд|подойдет|подходит|вариант|сытн|подходящ|что\s+(?:еще|можно|взять|поесть)|выбрат|улож|общий\s+бюджет|не\s+(?:келеди|аламын|жеуге)|усына|кайсысы|лайык|(?<!\p{L})етсиз(?!\p{L})|без\s+мяса)/iu.test(text);
}
export function needsShoppingPrepass(ctx:FastFoodContext):boolean {
 const s=shoppingConstraintsForContext(ctx);
 return isShoppingDecision(ctx)&&(s.budget!==null||s.avoidMeat||s.uncertainBudget||ctx.shoppingStateUnavailable===true);
}
const meat=/(?:куриц|говяд|свинин|бекон|ветчин|баран|мяс|тауык|сиыр|кой\s+ет|(?<!\p{L})ет(?!\p{L})|chicken|beef|pork|lamb)/iu;
export function eligibleShoppingItems(ctx:FastFoodContext,items:ShoppingItem[]=ctx.menuSnapshot?.items||[]) {
 const s=shoppingConstraintsForContext(ctx);const vocabulary=menuVocabulary(items);
 const noMeat=(item:ShoppingItem,depth=0):boolean=>{
  const composition=String(item.composition||item.description||"").trim();
  // Remove only explicitly negated ingredient names; other positive meat stays authoritative.
  const positiveComposition=foldIntentText(composition).replace(/(?<!\p{L})(?<!не\s)(?:без|не\s+содержит)\s+(?:мяс\p{L}*|куриц\p{L}*|говяд\p{L}*|свинин\p{L}*|бекон\p{L}*|ветчин\p{L}*|баран\p{L}*)(?:\s+(?:и|или)\s+(?:мяс\p{L}*|куриц\p{L}*|говяд\p{L}*|свинин\p{L}*|бекон\p{L}*|ветчин\p{L}*|баран\p{L}*))*/giu," ");
  if(!composition||meat.test(positiveComposition))return false;
  for(const other of items){const name=String(other.name||"").trim();if(other!==item&&name&&composition.toLowerCase().includes(name.toLowerCase())&&(depth>=2||!noMeat(other,depth+1)))return false;}
  return true;
 };
 return items.filter(item=>item&&item.available!==false&&String(item.name||"").trim()
  &&!menuItemBlockedByNotes(ctx.activeShiftNotes||[],item,vocabulary).blocked
  &&(s.budget===null||Number.isFinite(Number(item.price))&&Number(item.price)>0&&Number(item.price)<=s.budget)
  &&(!s.avoidMeat||noMeat(item)));
}

/** A small, explicit basket quote is arithmetic on current SKU facts, never an order. */
export function shoppingBasketQuote(ctx:FastFoodContext) {
 const text=foldIntentText(visible(ctx.text));
 if(!/(?:вместе|итого|общ|улож|сумм|жалпы|барлыгы|екеу|сыя|сия)/iu.test(text))return null;
 if(/(?:закаж|заказыва|оформ|оплат|чек|отмен|тапсырыс\s+(?:жаса|бер))/iu.test(text))return null;
 if(!ctx.menuSnapshot||ctx.menuSnapshot.source==="menu_unavailable"||ctx.menuGrounding?.menu_lookup==="unavailable"||ctx.menuGrounding?.error)return null;
 const items=(ctx.menuSnapshot.items||[]) as ShoppingItem[];
 const ordered:Array<{item:ShoppingItem;at:number;end:number;quantity:number}>=[];
 const escape=(v:string)=>v.replace(/[.*+?^$()|[\]{}\\]/g,"\\$&");
 for(const item of items){
  const name=foldIntentText(String(item.name||""));if(!name)continue;
  const re=new RegExp("(?<!\\p{L})(?:(\\d{1,2}|два|две|еки)\\s+)?"+escape(name)+"(?!\\p{L})","giu");
  for(const hit of text.matchAll(re)){
   const quantity=hit[1]?/два|две|еки/iu.test(hit[1])?2:Number(hit[1]):1;
   if(quantity<1||quantity>10)return null;
   ordered.push({item,at:hit.index!,end:hit.index!+hit[0].length,quantity});
  }
 }
 ordered.sort((a,b)=>(b.end-b.at)-(a.end-a.at));
 const selected:typeof ordered=[];
 for(const hit of ordered)if(!selected.some(other=>hit.at<other.end&&hit.end>other.at))selected.push(hit);
 if(!selected.length||selected.length===1&&selected[0].quantity===1)return null;
 const allowed=eligibleShoppingItems({...ctx,shoppingConstraints:{...shoppingConstraintsForContext(ctx),budget:null}},items);
 if(selected.some(({item})=>!allowed.includes(item)||!Number.isFinite(Number(item.price))||Number(item.price)<=0))return null;
 const total=selected.reduce((sum,{item,quantity})=>sum+Number(item.price)*quantity,0);
 const budget=shoppingConstraintsForContext(ctx).budget;
 return {lines:selected.map(({item,quantity})=>({name:String(item.name),quantity,unit_price:Number(item.price)})),total,budget,fits:budget===null?null:total<=budget,delivery_included:false,checkout_authority:false};
}

export function shoppingEvidence(ctx:FastFoodContext,items:ShoppingItem[]=ctx.menuSnapshot?.items||[]){
 const s=shoppingConstraintsForContext(ctx);if(s.budget===null&&!s.avoidMeat&&!s.uncertainBudget&&!ctx.shoppingStateUnavailable)return null;const known=ctx.menuSnapshot?.source!=="menu_unavailable"&&Array.isArray(ctx.menuSnapshot?.items);
 return {budget:s.budget,currency:"KZT",avoid_meat:s.avoidMeat,amount_needs_clarification:s.uncertainBudget,source:"customer_explicit_current_session",expires_at:s.expiresAt,checkout_authority:false,
  session_storage:ctx.shoppingStateUnavailable?"unavailable":"available",basket_quote:shoppingBasketQuote(ctx),catalog_state:known?"current_turn_snapshot":"unknown",eligible_items:known?eligibleShoppingItems(ctx,items).slice(0,8).map(item=>({name:item.name,price:item.price,composition:String(item.composition||item.description||"").slice(0,160)})):[],
  rule:"Keep these explicit customer constraints through followups until their explicit reset/change or session expiry. Only verified available, note-permitted items can be recommended. Actual requested catalog prices remain facts even above the ceiling. Unknown composition is not proof of dietary/allergen safety. Never infer a combined basket total or checkout authority."};
}

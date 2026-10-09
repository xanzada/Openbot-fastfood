import type { FastFoodContext } from "../context/types.js";

// Only a composition follow-up carries a prior product identity into this turn.
// Previous replies never supply either the identity or the ingredient facts.
const COMPOSITION_FOLLOW_UP_RE = /^(?:(?:а|ал)\s+)?(?:ішінде\s+не\s+(?:бар|болады)|ишинде\s+не\s+бар|что\s+(?:у\s+него\s+)?внутри|из\s+чего(?:\s+(?:он|она|оно|это))?(?:\s+(?:состоит|сделан|сделана|сделано))?|(?:(?:его|её|ее|оның)\s+)?(?:состав|құрамы|курамы)(?:\s+(?:какой|қандай))?)[?.!]*$/iu;
const NEUTRAL_ACK_RE = /^(?:спасибо|рахмет|ок|ладно|жақсы|жарайды|понятно|түсінікті)[.!?\s]*$/iu;
const fold = (value: unknown) => String(value || "").toLowerCase().replace(/ё/g, "е").trim();
const unquoted = (value: unknown) => String(value || "").replace(/«[^»]*»|“[^”]*”|"[^"]*"/gu, "");

export function isContextualCompositionQuestion(text: unknown): boolean {
  return COMPOSITION_FOLLOW_UP_RE.test(fold(unquoted(text)));
}

export function customerCompositionSubject(ctx: FastFoodContext): string | null {
  if (!isContextualCompositionQuestion(ctx.text)) return null;
  const items = Array.isArray(ctx.menuSnapshot?.items) ? ctx.menuSnapshot.items : [];
  const history = (Array.isArray(ctx.chatHistory) ? ctx.chatHistory : [])
    .filter((entry: any) => entry.role === "user").slice(-6);
  for (const entry of history.reverse()) {
    const text = fold(unquoted(entry.text || entry.content));
    if (!text || text === fold(ctx.text)) continue;
    const words = text.match(/\p{L}{3,}/gu) || [];
    const names = [...new Set(items.filter((item: any) => {
      const nameWords = fold(item.name || item.title).match(/\p{L}{3,}/gu) || [];
      return nameWords.some((name) => words.some((word) => word === name || name.length >= 4 && word.startsWith(name)));
    }).map((item: any) => String(item.name || item.title).trim()).filter(Boolean))];
    if (names.length === 1) return names[0];
    if (names.length > 1 || !NEUTRAL_ACK_RE.test(text)) return null;
  }
  return null;
}

export function isMenuAttributeVerificationQuestion(value:unknown):boolean {
 const text=fold(unquoted(value));
 return /(?:об[ъь]ем|көлем|колем|размер)(?!\p{L})/iu.test(text)
  && /(?:подтверд|проверь|уточн|какой|сколько|нақты|тексер|қандай|не\s+придум|по\s+меню)/iu.test(text);
}
const MENU_RELATION_FOLLOW_UP_RE=/^(?:(?:а|и|ал)\s+)?(?:он|она|оно|это|ол)(?!\p{L})[^.!?]{0,140}(?:отдельно|в\s+(?:составе\s+)?комбо|бөлек|болек|комбода)[?.!]*$/iu;
/** A relation question can use only a fresh, scoped customer identity, never a previous reply. */
export function customerMenuRelationSubject(ctx:FastFoodContext):{subject:string|null;needsClarification:boolean}|null {
 const current=fold(unquoted(ctx.text));const attribute=isMenuAttributeVerificationQuestion(ctx.text);if(!attribute&&!MENU_RELATION_FOLLOW_UP_RE.test(current))return null;
 const items=Array.isArray(ctx.menuSnapshot?.items)?ctx.menuSnapshot.items:[];
 const exactNames=(text:string)=>{
  const names=[...new Set(items.map((item:any)=>String(item.name||item.title||"").trim()).filter(Boolean))].sort((a,b)=>b.length-a.length);
  const spans:{name:string;start:number;end:number}[]=[];
  for(const name of names){
   const target=fold(name);let from=0;let start:number;
   while((start=text.indexOf(target,from))!==-1){from=start+target.length;const end=from;
    if(/\p{L}|\p{N}/u.test(text[start-1]||"")||/\p{L}|\p{N}/u.test(text[end]||""))continue;
    if(!spans.some(span=>start<span.end&&end>span.start))spans.push({name,start,end});
   }
  }
  return [...new Set(spans.map(span=>span.name))];
 };
 // A newly stated product takes precedence over pronoun recovery.
 const currentNames=exactNames(current);if(currentNames.length)return attribute?{subject:currentNames.length===1?currentNames[0]:null,needsClarification:currentNames.length!==1}:null;
 const unknown={subject:null,needsClarification:true};const now=Date.now();
 for(const row of (Array.isArray(ctx.chatHistory)?ctx.chatHistory:[]).slice(-12).reverse()){
  if(!row||row.role!=="user")continue;
  const text=fold(unquoted(row.text??row.content??row.body??""));if(text===current)continue;
  if(row.instanceId&&row.instanceId!==ctx.instanceId||row.instance_id&&row.instance_id!==ctx.instanceId)return unknown;
  if(row.phone&&String(row.phone).replace(/\D/g,"")!==String(ctx.phone).replace(/\D/g,""))return unknown;
  const raw=row.createdAt??row.timestamp;const at=typeof raw==="number"?raw:Date.parse(String(raw||""));
  if(!Number.isFinite(at)||at>now||at<=now-30*60_000)return unknown;
  if(NEUTRAL_ACK_RE.test(text))continue;
  const names=exactNames(text);return names.length===1?{subject:names[0],needsClarification:false}:unknown;
 }
 return unknown;
}

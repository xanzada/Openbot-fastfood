import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFinalText } from '../src/agent/finalValidator.js';
const base: any = {instanceId:'audit-allergy-continuation',phone:'fixture-guest',language:'ru',text:'У ребёнка аллергия на орехи',chatHistory:[],config:{},activeOrder:null,activeShiftNotes:[],menuSnapshot:{items:[{name:'Донер куриный',price:1800,composition:'Курица, лаваш, томат'}]}};
const grounded={toolsCalled:['searchMenu']};
const history=[{role:'user',content:'У ребёнка аллергия на орехи'},{role:'assistant',content:'Нет подтверждённых данных об аллергенах.'}];
for(const [id, input, raw, previous] of [
 ['current-worry',base.text,'Не переживайте, всё будет хорошо.',[]],
 ['current-permission',base.text,'Можно смело давать.',[]],
 ['prior-food-permission','Можно дать ему это блюдо?','Не волнуйтесь, можно смело давать.',history],
 ['prior-food-short','Можно ему дать?','Не переживайте, всё будет хорошо.',history],
 ['prior-food-KK','Осы тағамды беруге бола ма?','Уайымдамаңыз, ала беріңіз.',[{role:'user',content:'Баламда жаңғаққа аллергия бар'}]],
] as const) test(id,()=>{
 const result=validateFinalText(raw,{...base,text:input,chatHistory:previous,language:id.endsWith('KK')?'kk':'ru'},grounded);
 assert.doesNotMatch(result.text,/не переживайте|не волнуйтесь|можно смело|уайымдамаңыз/iu);
 assert.match(result.text,/не могу|не могу|кепілдік бере алмай/iu);
});
for(const [id, input, raw, previous] of [
 ['payment-now','Не получается оплатить','Не переживайте, я помогу с оплатой.',history],
 ['payment-explicit-health-now',base.text,'Не переживайте, я помогу с оплатой.',history],
 ['no-prior-health','Можно дать ему это блюдо?','Не волнуйтесь, помогу выбрать.',[]],
 ['assistant-health-only','Можно дать ему это блюдо?','Не волнуйтесь, помогу выбрать.',[{role:'assistant',content:'У ребёнка аллергия на орехи'}]],
 ['prior-subject-changed','Можно дать ему это блюдо?','Не волнуйтесь, помогу выбрать.',[...history,{role:'user',content:'Как оплатить заказ?'}]],
 ['quoted-prior','Можно дать ему это блюдо?','Не волнуйтесь, помогу выбрать.',[{role:'user',content:'Он написал «У ребёнка аллергия на орехи»'}]],
 ['negative-quote',base.text,'Я не могу сказать «не переживайте» при аллергии.',history],
] as const) test(id,()=>assert.equal(validateFinalText(raw,{...base,text:input,chatHistory:previous},grounded).text,raw));

import test from "node:test";
import assert from "node:assert/strict";
import { validateFinalText } from "../src/agent/finalValidator.js";
const ctx = (items: any[], text = "Кола қанша тұрады?") => ({
 instanceId: "fixture", phone: "77000000000", language: "ru", text,
 runtimeStatus: { is_accepting_orders: true, within_work_hours: true },
 activeShiftNotes: [], activeOrder: null, menuSnapshot: { items }, config: {}, fetchedSettings: {}, hardRealtimeContext: {},
} as any);
const menu = [{ name: "Coca-Cola", price: 450, composition: "вода, сахар" }, { name: "Спрайт", price: 500 }];
test("one menu read cannot authorize a wrong named product price", () => {
 const r = validateFinalText("Кола — 999 ₸.", ctx(menu), { toolsCalled: ["searchMenu"] });
 assert.doesNotMatch(r.text, /999/);
 assert.ok(r.warnings.includes("menu_price_mismatch_removed"));
});
test("one product cannot borrow another product's correct price", () => {
 const r = validateFinalText("Кола — 500 ₸. Спрайт — 450 ₸.", ctx(menu), { toolsCalled: ["searchMenu"] });
 assert.doesNotMatch(r.text, /Кола — 500|Спрайт — 450/);
});
test("actual unit price and decimal price survive", () => {
 const r = validateFinalText("Кола — 450 ₸.", ctx(menu), { toolsCalled: ["searchMenu"] });
 assert.match(r.text, /450/);
 const d = validateFinalText("Спрайт — 499,5 ₸.", ctx([{ name: "Спрайт", price: 499.5 }], "Спрайт қанша?"), { toolsCalled: ["searchMenu"] });
 assert.match(d.text, /499,5/);
});
test("unknown and empty ingredient fields cannot authorize an allergen absence", () => {
 for (const composition of [undefined, "", "вода, сахар", "содержит орехи"]) {
  const r = validateFinalText("В коле нет орехов.", ctx([{ name: "Кола", price: 450, ...(composition === undefined ? {} : { composition }) }]), { toolsCalled: ["searchMenu"] });
  assert.doesNotMatch(r.text, /нет орехов/);
 }
});
test("catalog omission cannot prove medical safety", () => {
 const r = validateFinalText("Кола безопасна при аллергии.", ctx(menu), { toolsCalled: ["searchMenu"] });
 assert.doesNotMatch(r.text, /безопасна/);
});
test("explicit absence stated in source composition can be repeated without blanket safety", () => {
 const r = validateFinalText("Кола без орехов.", ctx([{ name: "Кола", price: 450, composition: "вода, сахар. Без орехов." }], "Кола"), { toolsCalled: ["searchMenu"] });
 assert.match(r.text, /без орехов/);
});
test("honest missing composition disclosure remains a useful answer", () => {
 for (const text of ["Нет данных о составе колы.", "Не могу подтвердить отсутствие орехов.", "Не могу подтвердить безопасность при аллергии."]) {
  const r = validateFinalText(text, ctx(menu), { toolsCalled: ["searchMenu"] });
  assert.equal(r.text, text);
 }
});


test("accepted order statement needs a found Hub order", () => {
 for (const text of ["Ваш заказ принят.", "Тапсырысыңыз қабылданды."]) {
  const missing = validateFinalText(text, ctx(menu), { toolsCalled: ["checkOrderStatus"], toolFindings: { orderFound: false } });
  assert.notEqual(missing.text, text);
  const found = validateFinalText(text, ctx(menu), { toolsCalled: ["checkOrderStatus"], toolFindings: { orderFound: true, orderStatus: "confirmed", orderStage: "awaiting_receipt" } });
  assert.equal(found.text, text);
 }
});
test("already notified operator statement requires a real created case", () => {
 const text = "Оператор уже уведомлен.";
 const noCase = validateFinalText(text, ctx(menu), { toolsCalled: [], toolFindings: { escalationCreated: false } });
 assert.doesNotMatch(noCase.text, /уже уведомлен/);
 assert.ok(!noCase.warnings.includes("escalation_promise_ungrounded"), "a hallucinated notification must not create an SOS");
 const created = validateFinalText(text, ctx(menu), { toolsCalled: ["escalateToAdmin"], toolFindings: { escalationCreated: true, escalationNotificationAccepted: true } });
 assert.equal(created.text, text);
});
test("negative assertions, imperative requests and quoted labels are not false action claims", () => {
 for (const text of ["Ваша кола не готова.", "Колаңыз дайын емес.", "Я заказ не оформил.", "Заказ ещё не принят.", "Оператор пока не уведомлен.", "Примите заказ, пожалуйста.", "Статус «Ваш заказ принят» пока не подтверждён.", "Текст «Оператор уже уведомлен» пока не подтверждён."]) {
  const out = validateFinalText(text, ctx(menu), { toolsCalled: [], toolFindings: { orderFound: false, escalationCreated: false } });
  assert.equal(out.text, text);
 }
});
test("positive ingredient claim must exist in this named product composition", () => {
 const bad = validateFinalText("Кола содержит арахис.", ctx(menu, "Кола"), { toolsCalled: ["searchMenu"] });
 assert.doesNotMatch(bad.text, /содержит арахис/);
 const good = validateFinalText("Кола содержит воду и сахар.", ctx(menu, "Кола"), { toolsCalled: ["searchMenu"] });
 assert.equal(good.text, "Кола содержит воду и сахар.");
});


test("uncertainty in one clause cannot authorize unsafe affirmative facts in another", () => {
 for (const text of ["Состав неизвестен, но блюдо безопасно для аллергии.", "Не могу подтвердить состав, но в салате нет орехов.", "Не могу подтвердить состав и в салате нет орехов.", "Құрамы белгісіз, бірақ салатта жаңғақ жоқ."]) {
  const out = validateFinalText(text, ctx([{ name: "Салат", price: 1500, composition: "Огурец, помидор" }], "Салат"), { toolsCalled: ["searchMenu"] });
  assert.notEqual(out.text, text);
  assert.doesNotMatch(out.text, /безопасно для аллергии|в салате нет орехов/);
 }
});
test("a tool name without found order evidence cannot authorize accepted order", () => {
 const text = "Ваш заказ принят.";
 const out = validateFinalText(text, ctx(menu), { toolsCalled: ["checkOrderStatus"], toolFindings: {} });
 assert.notEqual(out.text, text);
});



test("common allergen absence cannot be invented or borrowed from another allergen", () => {
 for (const text of ["В коле нет арахиса.", "Кола не содержит молока.", "Кола без яиц.", "Кола без кунжута."]) {
  const out = validateFinalText(text, ctx(menu, "Кола"), { toolsCalled: ["searchMenu"] });
  assert.notEqual(out.text, text);
 }
 const source = [{ name: "Кола", price: 450, composition: "вода, сахар. Без арахиса." }];
 assert.equal(validateFinalText("Кола без арахиса.", ctx(source, "Кола"), { toolsCalled: ["searchMenu"] }).text, "Кола без арахиса.");
 assert.notEqual(validateFinalText("Кола без яиц.", ctx(source, "Кола"), { toolsCalled: ["searchMenu"] }).text, "Кола без яиц.");
});


test("found cancelled or unknown order does not authorize active accepted or ready state", () => {
 for (const orderStatus of ["cancelled", "unknown"]) for (const text of ["Ваш заказ принят.", "Ваш заказ готов."]) {
  const out = validateFinalText(text, ctx(menu), { toolsCalled: ["checkOrderStatus"], toolFindings: { orderFound: true, orderStatus, orderStage: "preparing" } } as any);
  assert.notEqual(out.text, text);
 }
});
test("read-only order lookup never authorizes a manual order write", () => {
 for (const text of ["Я оформил заказ.", "Я оформил ваш заказ.", "Тапсырысыңызды рәсімдедім."]) {
  const out = validateFinalText(text, ctx(menu), { toolsCalled: ["checkOrderStatus"], toolFindings: { orderFound: true, orderStatus: "confirmed", orderStage: "awaiting_receipt" } } as any);
  assert.notEqual(out.text, text);
 }
});
test("state evidence preserves confirmed ready and preparation truth while rejecting mismatches", () => {
 for (const [orderStatus, orderStage, text] of [["confirmed", "awaiting_receipt", "Ваш заказ принят."], ["ready", "unknown", "Ваш заказ готов."], ["paid", "preparing", "Ваш заказ готовится."]]) {
  const out = validateFinalText(text, ctx(menu), { toolsCalled: ["checkOrderStatus"], toolFindings: { orderFound: true, orderStatus, orderStage } } as any);
  assert.equal(out.text, text);
 }
 const out = validateFinalText("Ваш заказ готов.", ctx(menu), { toolsCalled: ["checkOrderStatus"], toolFindings: { orderFound: true, orderStatus: "paid", orderStage: "preparing" } } as any);
 assert.notEqual(out.text, "Ваш заказ готов.");
});


test("an unknown product cannot borrow the requested item's price", () => {
 const bad = validateFinalText("Бургер — 450 ₸.", ctx(menu, "Кола сколько стоит?"), { toolsCalled: ["searchMenu"] });
 assert.doesNotMatch(bad.text, /Бургер — 450/);
 for (const text of ["450 ₸.", "Цена — 450 ₸.", "Он стоит 450 ₸."]) {
  assert.equal(validateFinalText(text, ctx(menu, "Кола сколько стоит?"), { toolsCalled: ["searchMenu"] }).text, text);
 }
});
test("internal provider error identifiers cannot become a customer answer", () => {
 const text="TOOL_CHOICE_IGNORED Incident ID.";
 const out=validateFinalText(text, ctx(menu), { toolsCalled: [] });
 assert.doesNotMatch(out.text, /TOOL_CHOICE_IGNORED|Incident ID/);
});


test("a customer's product cannot be claimed ready before an order exists", () => {
 for (const text of ["Колаңыз дайын!", "Ваша кола готова."]) {
  const bad=validateFinalText(text, ctx(menu, "Кола алайын"), { toolsCalled: ["searchMenu", "sendMenuLink"], toolFindings: { orderFound: false } });
  assert.notEqual(bad.text, text);
  const good=validateFinalText(text, ctx(menu, "Кола"), { toolsCalled: ["checkOrderStatus"], toolFindings: { orderFound: true, orderStatus: "ready", orderItems: [{ name: "Coca-Cola" }] } });
  assert.equal(good.text, text);
 }
 assert.equal(validateFinalText("Кола бар.", ctx(menu), { toolsCalled: ["searchMenu"] }).text,"Кола бар.");
});


test("negating one clause cannot authorize a later positive action assertion", () => {
 for (const text of ["Ваш заказ не принят, но я уже оформил заказ.", "Оператор не уведомлён, но я передал администратору заявку."]) {
  const out=validateFinalText(text, ctx(menu), { toolsCalled: [], toolFindings: {} });
  assert.notEqual(out.text,text);
 }
 assert.equal(validateFinalText("Ваш заказ пока не принят.",ctx(menu),{toolsCalled:[]}).text,"Ваш заказ пока не принят.");
});
test("case creation proves a case handoff but not notification delivery", () => {
 const findings={escalationCreated:true};
 assert.notEqual(validateFinalText("Оператор уже уведомлён.",ctx(menu),{toolsCalled:["escalateToAdmin"],toolFindings:findings}).text,"Оператор уже уведомлён.");
 assert.equal(validateFinalText("Я передал заявку оператору.",ctx(menu),{toolsCalled:["escalateToAdmin"],toolFindings:findings}).text,"Я передал заявку оператору.");
});


test("ingredient and absence facts cannot be borrowed by an unlisted named dish", () => {
 const source=[{name:"Кола",price:450,composition:"вода, сахар. Без орехов."}];
 for(const text of ["Бургер содержит воду и сахар.","В бургере нет орехов."]){
  const out=validateFinalText(text,ctx(source,"Кола"),{toolsCalled:["searchMenu"]});
  assert.notEqual(out.text,text);
 }
 for(const text of ["Он содержит воду и сахар.","В этом блюде нет орехов."]){
  const out=validateFinalText(text,ctx(source,"Кола"),{toolsCalled:["searchMenu"]});
  assert.equal(out.text,text);
 }
});

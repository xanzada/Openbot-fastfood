import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import ts from "typescript";
import {detectOperatorCaseKind, isOrderCancellationRequest} from "../src/services/operatorCase.service.js";
import {intentMatches, isLikelyMenuQuestion} from "../src/utils/intentText.js";

const denied = [
  "Не отменяйте мой заказ, всё нормально", "Прошу не отменять заказ", "Не хочу отменять мой заказ",
  "Отменять заказ не надо", "Отмена заказа не требуется", "Тапсырысымды жоймаңыз, бәрі дұрыс",
  "Тапсырыстан бас тартпаймын", "Тапсырыстан бас тартқым келмейді", "Тапсырыстан бас тартудың қажеті жоқ",
  "Тапсырысты болдырмаудың қажеті жоқ",
];
const requested = [
  "Отмените мой заказ", "отмена заказа", "тапсырысымды болдырмаңыз", "заказ отменить хочу",
  "тапсырыстан бас тартқым келеді", "тапсырысымды жойыңыз",
  "Не отменяйте первый заказ, но отмените второй заказ", "Не хочу говорить с оператором, отмените мой заказ",
  "Тапсырыстан бас тартпаймын, бірақ екінші тапсырысты жойыңыз",
];
for (const phrase of denied) test("denied cancellation never enters either canonical classifier: " + phrase, () => {
  assert.equal(isOrderCancellationRequest(phrase), false);
  assert.notEqual(detectOperatorCaseKind(phrase), "cancel_request");
});
for (const phrase of requested) test("real cancellation remains actionable in its own clause: " + phrase, () => {
  assert.equal(isOrderCancellationRequest(phrase), true);
  assert.equal(detectOperatorCaseKind(phrase), "cancel_request");
});
function routeHarness() {
  const exports: any = {}, created: any[] = [], writes: any[] = [];
  const modules: any = {
    "node:crypto": crypto,
    "./redis.service.js": {getComplaintMedia: async () => null, clearComplaintMedia: async () => {},
      markComplaintClarificationPending: async () => {writes.push("clarification"); return true;},
      saveCaseMedia: async () => true, takeComplaintClarification: async () => null},
    "./operatorCase.service.js": {detectOperatorCaseKind, getActiveOperatorCaseId: async () => null,
      createOperatorCase: async (data: any) => {created.push(data); return {id: "synthetic_case", ...data};}, bumpOperatorCaseSignal: async () => true},
    "./auditLogger.service.js": {auditError: () => {}}, "../utils/intentText.js": {intentMatches, isLikelyMenuQuestion},
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL("../src/services/complaintRouting.service.ts", import.meta.url), "utf8"),
    {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText,
    {exports, require: (name: string) => modules[name], Date, console});
  return {created, writes, route: (text: string) => exports.routeComplaintToAdmin(
    {instanceId: "fixture", phone: "77000000002", language: "ru", text, config: {}},
    {summary: "Synthetic cancellation", source: "cancel_request", customerText: text, customerReply: "Передал оператору"})};
}
for (const phrase of [denied[0], denied[5], requested[6], requested[8]]) {
  test("direct cancellation routing follows actual clause evidence: " + phrase, async () => {
    const h = routeHarness(), result = await h.route(phrase);
    if (denied.includes(phrase)) {
      assert.equal(h.created.length, 0); assert.equal(h.writes.length, 0); assert.equal(result.caseId, null);
      assert.doesNotMatch(result.customerReply || "", /Передал оператору|жібердім/iu);
    } else {assert.equal(h.created.length, 1); assert.equal(result.action, "operator_case_created");}
  });
}

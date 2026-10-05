import test from "node:test";
import assert from "node:assert/strict";
import {isExplicitHumanOperatorRequest} from "../src/services/complaintRouting.service.js";
for (const text of ["Позовите оператора","Хочу живого оператора","Оператормен сөйлескім келеді","оператор керек","Мне нужен оператор","Маған адам керек","Операторды шақырыңыз","Что посоветуете из меню? И позовите оператора","оператор","Не хочу бота, позовите оператора","Оператор не нужен, но хочу живого оператора"]) {
  test("explicit human request recognized: "+text,()=>assert.equal(isExplicitHumanOperatorRequest(text),true));
}
for (const text of ["Кола бар ма?","Как работает оператор функций?","Оператор не нужен","Оператор керек емес","Не зовите оператора","Два человека хотят колу","Не нужен человек","Маған оператор қажет емес","Не хочу говорить с оператором.","Не соединяйте меня с оператором.","Оператор сказал, что нужно добавить сыр.","Оператору нужна пицца.","Оператор сказал: «Хочу живого оператора».","Мне нужен телефон оператора","Позовите оператора. Оператор не нужен"]) {
  test("ordinary or refused operator turn stays negative: "+text,()=>assert.equal(isExplicitHumanOperatorRequest(text),false));
}

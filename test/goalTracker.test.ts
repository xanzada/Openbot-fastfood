import test from "node:test";
import assert from "node:assert/strict";
import { resolveGoalKind } from "../src/services/goalTracker.service.js";

function ctx(text: string) {
  return { text } as any;
}

test("complaint signals beat every other intent", () => {
  assert.equal(resolveGoalKind(ctx("заказ кешікті, шағымым бар"), null), "complaint");
  assert.equal(resolveGoalKind(ctx("мой заказ опаздывает уже час"), null), "complaint");
});

test("an explicit human request is its own mission", () => {
  assert.equal(resolveGoalKind(ctx("оператор шақырыңызшы"), null), "human");
  assert.equal(resolveGoalKind(ctx("соедините с менеджером"), null), "human");
});

test("payment, status and ordering are recognised from plain text", () => {
  assert.equal(resolveGoalKind(ctx("kaspi номерін жіберші, төлемін"), null), "payment");
  assert.equal(resolveGoalKind(ctx("где мой заказ, қашан келед"), null), "status");
  assert.equal(resolveGoalKind(ctx("заказ хочу оформить"), null), "order");
});

test("the think-layer label wins when it is confident", () => {
  assert.equal(resolveGoalKind(ctx("жай ғана сұрайын"), { goal: "status" } as any), "status");
  assert.equal(resolveGoalKind(ctx("сәлем"), { goal: "smalltalk" } as any), "smalltalk");
});

test("unknown stays unknown instead of inventing a mission", () => {
  assert.equal(resolveGoalKind(ctx("болды, рақмет"), null), "unknown");
});

import assert from "node:assert/strict";
import test from "node:test";
import { classifyMenuLinkRefusal, hasDirectOrderIntent } from "../src/skills/menuLink.skill.js";
import { classifyKitchenSalesPolicy } from "../src/services/kitchenPolicy.service.js";
import { hasMenuBrowsingIntent, hasMenuInquiryIntent, MENU_INQUIRY_RE } from "../src/utils/orderIntent.js";
import { hasExplicitMenuLinkIntent } from "../src/utils/magicLink.js";
import { BUSINESS_INFO_RE } from "../src/agent/toolPolicy.js";
import { intentMatches } from "../src/utils/intentText.js";

const readyCtx = {
  hardRealtimeContext: { runtime_available: true },
  explicitMenuLinkIntent: true,
  magicLink: "https://prestige.alemi.kz/?phone=77476884956&hash=abc123",
} as any;

test("intent separation: direct orders vs menu inquiries", () => {
  // Direct order intent (guest attempting to place an order immediately)
  assert.equal(hasDirectOrderIntent("Ассалаумағалейкум брат, екі донер заказ берейн деп ем"), true);
  assert.equal(hasDirectOrderIntent("екі донер жасап қойшы"), true);
  assert.equal(hasDirectOrderIntent("донер алғым келеді"), true);

  // Menu inquiries (guest just wants to see/browse menu, prices, links)
  assert.equal(hasDirectOrderIntent("Мәзірді қайдан қараймын"), false);
  assert.equal(hasDirectOrderIntent("Мәзір жіберші"), false);
  assert.equal(hasDirectOrderIntent("Сілтеме бер"), false);
  assert.equal(hasDirectOrderIntent("Донер қанша тұрады?"), false);
  assert.equal(hasDirectOrderIntent("Қайдан көрсем болады?"), false);
});

test("menu inquiry and browsing recognition", () => {
  assert.equal(hasMenuInquiryIntent("Мәзірді қайдан қараймын"), true);
  assert.equal(hasMenuInquiryIntent("мәзір жіберші"), true);
  assert.equal(hasMenuInquiryIntent("қайдан көрем"), true);
  assert.equal(hasMenuInquiryIntent("сілтеме жібер"), true);
  assert.equal(hasMenuInquiryIntent("бағалары қандай"), true);

  assert.equal(hasMenuBrowsingIntent("Мәзірді қайдан қараймын"), true);
  assert.equal(hasExplicitMenuLinkIntent("Мәзірді қайдан қараймын"), true);
});

test("off_hours kitchen sales policy allows menu link for browsing", () => {
  const offHoursPolicy = classifyKitchenSalesPolicy({ within_work_hours: false });
  assert.equal(offHoursPolicy.mode, "off_hours");
  assert.equal(offHoursPolicy.blocksAllSales, true);

  // Link must NOT be refused with kitchen_closed during off_hours
  const refusal = classifyMenuLinkRefusal(readyCtx, offHoursPolicy, true);
  assert.equal(refusal, null);
});

test("emergency or indefinite closed kitchen refuses checkout link", () => {
  const closedPolicy = classifyKitchenSalesPolicy({ is_accepting_orders: false, within_work_hours: true });
  assert.notEqual(closedPolicy.mode, "off_hours");
  assert.equal(closedPolicy.blocksAllSales, true);

  const refusal = classifyMenuLinkRefusal(readyCtx, closedPolicy, true);
  assert.equal(refusal, "kitchen_closed");
});

test("kitchen gate browsing filter logic", () => {
  function shouldPassToAgent(text: string, blocksAllSales = true): boolean {
    if (!blocksAllSales) return true;
    const isDirectOrder = hasDirectOrderIntent(text);
    return Boolean(
      !isDirectOrder &&
      (intentMatches(BUSINESS_INFO_RE, text) ||
       intentMatches(MENU_INQUIRY_RE, text) ||
       hasExplicitMenuLinkIntent(text) ||
       hasMenuBrowsingIntent(text))
    );
  }

  // Direct order while closed -> gate intercepts and informs restaurant is closed
  assert.equal(shouldPassToAgent("Ассалаумағалейкум брат, екі донер заказ берейн деп ем"), false);

  // Browsing while closed -> gate passes through to AI agent!
  assert.equal(shouldPassToAgent("Мәзірді қайдан қараймын"), true);
  assert.equal(shouldPassToAgent("Мәзір жіберші"), true);
  assert.equal(shouldPassToAgent("Сілтеме бер"), true);
  assert.equal(shouldPassToAgent("Донер қанша тұрады?"), true);
  assert.equal(shouldPassToAgent("Мекен-жайыңыз қайда?"), true);
  assert.equal(shouldPassToAgent("Жұмыс уақытыңыз қалай?"), true);
});

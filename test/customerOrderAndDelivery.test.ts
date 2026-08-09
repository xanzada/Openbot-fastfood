import assert from "node:assert/strict";
import test from "node:test";
import {
  customerOrderFromContext,
  customerOrderFromRecord,
  formatCustomerOrderStatus,
} from "../src/services/customerOrder.service.js";
import { deliverReceiptToClient } from "../src/services/receiptDelivery.service.js";
import { FAST_FOOD_SKILL_NAMES } from "../src/skills/index.js";
import { selectPublicMenuItems } from "../src/skills/searchMenu.skill.js";

test("delivery status keeps the exact status, order number, and ordered items", () => {
  const lookup = customerOrderFromRecord({
    id: "1234",
    phone: "77001234567",
    status: "delivery",
    items: [{ name: "Burger", qty: 1 }, { name: "Fries", qty: 2 }],
  }, "77001234567", "ru");

  assert.equal(lookup.state, "found");
  if (lookup.state !== "found") return;
  assert.equal(lookup.order.status, "delivery");
  assert.equal(lookup.order.stage, "delivery");
  assert.equal(lookup.order.statusLabel, "В пути");
  assert.equal(lookup.order.statusExplanation, "заказ у курьера и едет к вам");
  assert.match(formatCustomerOrderStatus(lookup.order, "ru"), /Заказ #1234.*В пути.*курьера.*Burger.*Fries/u);
  assert.doesNotMatch(formatCustomerOrderStatus(lookup.order, "ru"), /готовится/u);
});

test("order lookup returns no match and ambiguous match safely", () => {
  assert.deepEqual(customerOrderFromRecord(null, "77001234567", "kk"), { state: "not_found" });
  assert.deepEqual(customerOrderFromContext({ active_orders: [{ id: "1" }, { id: "2" }] }, "77001234567", "kk"), { state: "ambiguous" });
});

test("customer order projection excludes internal and private order fields", () => {
  const lookup = customerOrderFromRecord({
    id: "15",
    phone: "77001234567",
    status: "delivery",
    address: "Private address",
    comment: "Internal note",
    ai_comment: "Kitchen-only receipt",
    kitchen_status: "busy",
    items: [{ name: "Burger", qty: 1, cost: 2 }],
  }, "77001234567", "kk");

  assert.equal(lookup.state, "found");
  assert.deepEqual(Object.keys(lookup.state === "found" ? lookup.order : {}).sort(), ["items", "orderNumber", "stage", "status", "statusExplanation", "statusLabel"]);
  assert.ok(!FAST_FOOD_SKILL_NAMES.includes("getKitchenStatus" as never));
  assert.ok(!FAST_FOOD_SKILL_NAMES.includes("getShiftNotes" as never));
});

test("menu projection exposes only customer-facing fields", () => {
  const [item] = selectPublicMenuItems([{
    id: 1,
    name: "Burger",
    category_name: "Burgers",
    composition: "Beef, bun",
    price: 2500,
    available: true,
    kitchen_note: "internal",
    secret: "hidden",
  }], "burger");
  assert.deepEqual(item, {
    name: "Burger",
    category: "Burgers",
    ingredients: "Beef, bun",
    price: 2500,
    available: true,
  });
});

test("receipt is confirmed only after a matching successful backend response", async () => {
  const result = await deliverReceiptToClient({
    instanceId: "restaurant-a",
    phone: "77001234567",
    orderNumber: "1234",
    config: {},
    amount: 9700,
    senderName: "Арман Сейітов",
    bankName: "Kaspi",
    receiptBase64: Buffer.from("receipt").toString("base64"),
    mimeType: "image/jpeg",
    sourceMessageId: "wa-1",
  }, async () => ({ document_id: "delivery-1", order_id: "1234", uploaded_at: "2026-07-23T10:00:00.000Z" }));

  assert.deepEqual(result, { success: true, deliveryId: "delivery-1", deliveredAt: "2026-07-23T10:00:00.000Z" });
});

test("receipt failure, invalid recipient, and retry-safe nonconfirmation never report success", async () => {
  const failed = await deliverReceiptToClient({
    instanceId: "restaurant-a",
    phone: "77001234567",
    orderNumber: "1234",
    config: {},
    amount: 9700,
    senderName: "Арман Сейітов",
    bankName: "Kaspi",
    receiptBase64: Buffer.from("receipt").toString("base64"),
    mimeType: "image/jpeg",
    sourceMessageId: "wa-2",
  }, async () => ({ order_id: "9999" }));
  const invalid = await deliverReceiptToClient({
    instanceId: "restaurant-a",
    phone: "",
    orderNumber: "1234",
    config: {},
    amount: 9700,
    senderName: "Арман Сейітов",
    bankName: "Kaspi",
    receiptBase64: Buffer.from("receipt").toString("base64"),
    mimeType: "image/jpeg",
    sourceMessageId: "wa-3",
  });

  assert.equal(failed.success, false);
  assert.equal(invalid.success, false);
  if (!failed.success) assert.equal(failed.errorCode, "delivery_unconfirmed");
  if (!invalid.success) assert.equal(invalid.errorCode, "invalid_recipient");
});

import test from "node:test";
import assert from "node:assert/strict";
import { lastDiscussedOrderNumber } from "../src/utils/orderIntent.js";
import { pickConversationOrder } from "../src/services/customerOrder.service.js";

const context = {
  order: { id: "58", status: "pending", created_at: "2026-07-31 07:34:47" },
  active_order: { id: "58", status: "pending", created_at: "2026-07-31 07:34:47" },
  recent_orders: [
    { id: "59", status: "completed", created_at: "2026-07-31 07:35:18" },
    { id: "58", status: "pending", created_at: "2026-07-31 07:34:47" },
  ],
};

test("the conversation remembers which order it has been about", () => {
  const history = [
    { role: "user", text: "че там брат" },
    { role: "assistant", text: "Тапсырыс #59: Жолда — тапсырыс курьерде." },
    { role: "user", text: "қашан келеді" },
  ];
  assert.equal(lastDiscussedOrderNumber(history), "59");
});

test("a bare follow-up answers about the discussed order, not an older pending one", () => {
  // The site called #58 the active order, but every message in this chat was
  // about #59, so answering with #58 made the bot look like it had amnesia.
  const picked = pickConversationOrder(context, "59");
  assert.equal(picked?.id, "59");
});

test("an order the site has never heard of never overrides the active one", () => {
  assert.equal(pickConversationOrder(context, "1234"), null);
});

test("a genuinely newer order the guest has not mentioned yet still wins", () => {
  const newer = {
    order: { id: "60", status: "pending", created_at: "2026-07-31 09:00:00" },
    recent_orders: [
      { id: "60", status: "pending", created_at: "2026-07-31 09:00:00" },
      { id: "59", status: "completed", created_at: "2026-07-31 07:35:18" },
    ],
  };
  assert.equal(pickConversationOrder(newer, "59"), null);
});

test("an empty or missing history pins nothing", () => {
  assert.equal(lastDiscussedOrderNumber(null), "");
  assert.equal(lastDiscussedOrderNumber([{ role: "user", text: "тапсырыс #59 қайда" }]), "");
});

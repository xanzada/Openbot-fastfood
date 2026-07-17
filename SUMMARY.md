# DLE Website Webhook Integration Summary

Date: 2026-07-16

## 2026-07-17 AI Agent Skills Restored

Restored code-backed AI tools from the legacy `api_bot new.php` behavior:

- `searchMenu`: live DLE `get_menu_context` lookup with scored search across item name, category, label, description, composition, and prices.
- `checkOrderStatus`: live DLE order lookup by current WhatsApp phone or explicit `orderId`, using both `check_status` and legacy `get_order_context`.
- `getKitchenStatus`: live DLE runtime status with Redis fallback for wait time, emergency state, delivery/pickup flags, reset time, and payment details.
- `getShiftNotes`: active Redis shift notes for temporary kitchen/operator instructions.

Updated dynamic context injection:

- `preloadContext` now derives wait time and emergency state from live runtime/kitchen fields first.
- `FACTS_CONTEXT` now declares available code-backed tools.
- Agent instructions now explicitly require these tools for menu, order status, kitchen status, and shift notes.
- Exact `orderId` lookups now distinguish `found` from `active`, so completed/cancelled orders are visible without being presented as active.
- DLE-backed tool failures now go through structured audit logging, including missing `CRM_SECRET_TOKEN`, menu lookup failures, order lookup failures, runtime status failures, and CRM update failures.

Verification:

```text
npm run build
tsc -p tsconfig.json
passed
```

## 2026-07-16 New DLE Module Sync

Analyzed the updated legacy source files:

- `spa-internet-magazin - new.xml`
- `api_bot new.php`

Confirmed the updated module emits these website actions:

- `new_order`
- `status_changed`
- `request_payment`
- `order_rejected`
- `shift_note_created`
- `shift_note_deleted`

Synchronized the Openbot receiver with the updated schema:

- accepted `instance_id`, `restaurant_instance`, and `restaurantInstance` aliases;
- accepted `client_phone`, `clientPhone`, `customer_phone`, `customerPhone`, and `recipient` phone aliases;
- accepted `is_pickup` and `isPickup`;
- preserved the exact DLE action names and existing alias compatibility;
- accepted `secret_token` in request body/query for the new DLE `confirm_payment_and_print` / `/api/print_trigger` flow.

Synchronized kitchen runtime status behavior with the new DLE module:

- `wait_time <= 40` now normalizes to `0`;
- `wait_time` is capped to `720`;
- `hours_valid` is capped to `24`;
- preserved `reset_at` is capped to 24 hours from now;
- expired kitchen status resets to `wait_time: 0`;
- `payment_details` is capped to 6 records.

Verification:

```text
npm run build
tsc -p tsconfig.json
passed
```

Target: `C:\Users\Аз\Desktop\fastfood-old\Новая папка\Openbot-fastfood`

Legacy reference: `C:\Users\Аз\Desktop\fastfood-old\codex үшін\ggg`

## Integrated Legacy Actions

The legacy DLE website webhook actions are now received by Openbot:

- `new_order`
- `status_changed`
- `request_payment`
- `order_rejected`
- `shift_note_created`
- `shift_note_deleted`

The existing `src/controllers/kanban.ts` remains the single processing controller for these actions, preserving Redis locks, WhatsPro delivery, order-history writes, shift-note memory, kitchen/payment runtime lookup, and developer failure alerts.

## Added Dedicated DLE Receiver

Added `src/routes/dleWebhook.route.ts`.

The route registers legacy-compatible POST aliases:

- `/dle-webhook`
- `/website-webhook`
- `/api/dle-webhook`
- `/api/website-webhook`
- `/api/kanban-webhook`
- `/webhook/dle`
- `/webhook/kanban`
- `/webhook/website`

This catches the DLE SPA JSON payloads that previously went to the old webhook receiver, without changing the WhatsApp webhook route.

## Server Wiring

Updated `src/server.ts`:

- imports `dleWebhookRoute`;
- mounts it after WhatsApp webhooks and before system routes;
- keeps the existing `/kanban-webhook` route intact.

## Auth Compatibility

Added env-controlled auth for legacy DLE payloads:

```env
DLE_WEBHOOK_AUTH_REQUIRED=false
DLE_WEBHOOK_SECRET=
```

Default is `false` because the legacy DLE module posts JSON without auth headers. When enabled, the route accepts:

- `DLE_WEBHOOK_SECRET`
- `CRM_SECRET_TOKEN`
- `OPENBOT_WEBHOOK_SECRET`
- tenant secrets from NocoDB

## Printer Signal Parity

Updated `src/controllers/kanban.ts`:

- `new_order` now emits `print_new_order` to connected socket clients;
- `status_changed` with `paid` still emits `print_new_order`;
- customer notifications and bot memory writes remain unchanged.

## Environment Documentation

Updated `.env.example` with the DLE webhook compatibility settings.

## Verification

Passed:

```text
npm run build
exit code: 0
```

# DLE Website Webhook Integration Summary

Date: 2026-07-16

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

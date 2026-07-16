# Migration Summary

Date: 2026-07-16

Source of truth: `C:\Users\Аз\Desktop\fastfood-old\codex үшін\ggg`

Target repository: `C:\Users\Аз\Desktop\fastfood-old\Новая папка\Openbot-fastfood`

## 1. EOS Guards Applied

- Consulted `.bekzat-ai-eos` before code changes and applied its separation-of-concerns rules:
  - business logic belongs in TypeScript services/controllers, not only in prompts;
  - Redis state must stay tenant-scoped;
  - critical operational errors must notify the developer;
  - NodeNext TypeScript imports must include `.js`;
  - the core AI model routing layer is treated as immutable.
- `src/agent/modelRouter.ts` was not modified.
- No base64 writers, builder scripts, or generated binary patching were used. All TypeScript was written directly.

## 2. Broken Code Fixed

- Replaced the corrupted `src/controllers/kanban.ts` with a clean TypeScript controller.
- Replaced the broken `src/routes/system.route.ts` implementation and removed the invalid `config || 2{}` syntax.
- Removed duplicated inline developer-siren logic from `system.route.ts` and delegated failures to `notifyDeveloperSystemFailure`.
- Scrubbed real-looking Redis/NocoDB credentials from `.env.example` while preserving required env keys.

## 3. Legacy Kanban / DLE Webhook Migration

`src/controllers/kanban.ts` now handles the legacy webhook actions:

- `new_order`
- `status_changed`
- `request_payment`
- `order_rejected`
- `shift_note_created`
- `shift_note_deleted`
- `update_kitchen_status`
- `get_kitchen_status`
- `developer_alert`
- `complaint`

Implemented parity behaviors:

- idempotency locks via Redis;
- customer phone normalization;
- deterministic Kazakh/Russian customer messages;
- paid-status print socket emit;
- order lifecycle cleanup for terminal statuses;
- shift note create/delete sync;
- payment request fallback through runtime/config data;
- developer alert route for critical Kanban failures;
- admin complaint route for webhook-originated complaints.

## 4. Redis Kitchen Status Sync

Added Redis kitchen status state in `src/services/redis.service.ts`:

- `KitchenStatusState`
- `saveKitchenStatus`
- `getKitchenStatus`
- payment detail preservation
- `hours_valid` / `reset_at` support
- expired `reset_at` auto-reset to default open kitchen state

Integrated DLE runtime with Redis in `src/services/dle.service.ts`:

- successful DLE `get_runtime_status` reads sync `kitchen_status` into Redis;
- Redis kitchen status is used as fallback when DLE is unavailable;
- Redis kitchen status is also available when the restaurant domain is missing.

Updated `src/context/preloadContext.ts` so Redis runtime fallback reaches `FACTS_CONTEXT` and includes payment details in `hard_realtime_context`.

## 5. Shift Notes Parity

Expanded Redis shift note deletion behavior:

- delete by exact note id;
- fallback delete by matching note text;
- delete all notes for explicit empty/id-zero deletion payloads;
- purge stale note-derived assistant history entries after note deletion.

This matches the legacy behavior where deleted operational notes should stop influencing future AI replies.

## 6. Complaint Routing / Жалобы

Added `src/services/complaintRouting.service.ts`:

- shared complaint-to-admin routing;
- admin phone alias resolution (`admin_phone`, `admin`, `manager_phone`, `operator_phone`, `complaint_phone`, env fallback);
- pending complaint media attach/clear;
- escalation marker helpers;
- complaint text detection;
- Kazakh/Russian complaint clarification and acknowledgement replies.

Updated `src/routes/whatsappWebhook.route.ts`:

- complaint media with no text now asks the customer for a short description;
- complaint media with text routes to admin immediately and replies to the customer;
- pending complaint media after AI is routed to admin;
- `[ESCALATE_ADMIN]` routes admin escalation and is stripped from customer-visible text;
- `[ESCALATE_DEVELOPER]` notifies the developer and is stripped from customer-visible text;
- if admin phone is missing during complaint routing, the developer is notified.

Updated `src/skills/escalation.skill.ts` so the AI tool uses the same complaint routing service.

## 7. Developer Alerting

Developer notification is now wired through:

- Kanban controller failures and explicit `developer_alert`;
- `/kanban-webhook` and `/api/print_trigger` failures;
- WhatsApp webhook exceptions;
- media analysis technical failures;
- AI raw-text `[ESCALATE_DEVELOPER]` marker;
- complaint routing misconfiguration when admin phone is absent.

Developer alerting uses existing restaurant config and `DEVELOPER_PHONE` fallback through `notifyDeveloperSystemFailure`.

## 8. Prompt / AI Brain Synchronization

Rewrote `Бот промп.txt` into a structured operational prompt covering:

- architecture contract and separation of concerns;
- language lock;
- FACTS_CONTEXT truth rules;
- Redis/DLE kitchen status fields;
- shift note handling;
- complaint routing;
- developer alerting;
- webhook/Kanban parity;
- payment and order status guardrails;
- validation mindset.

Updated `src/agent/instructions.ts` with runtime instructions for:

- kitchen status;
- complaints / жалобы;
- developer alerts;
- escalation markers.

## 9. Verification

Commands executed successfully:

- `npm run build` -> exit code `0`
- `npm run check` -> exit code `0`

Additional verification:

- targeted source scan found no remaining `config || 2{}` corruption;
- targeted source scan found no `TS1490` / `TS1005` signatures;
- core AI Gemini/OpenRouter routing file was left unchanged.

## 10. Final State

The migration is complete in the target TypeScript system. The build passes, the originally corrupted files are repaired, and the missing legacy features are now represented as typed controllers/services instead of prompt-only behavior.

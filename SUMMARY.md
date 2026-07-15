# Integration Summary: Kanban / DLE Webhooks

The DLE/Kanban legacy business logic has been completely decoupled and migrated into the `Openbot-fastfood` system. Specifically:

**1. Architectural Stability:**
- The AI routing systems (Model Router & Fallback) have been strictly treated as *immutable*. No changes were applied to any AI core logic.

**2. New Infrastructure: `src/controllers/kanban.ts`**
- Created a fresh Kanban controller to take over all DLE webhooks parsing duties.
- **`new_order` Handling:** Generates detailed order tickets out of the DLE cart payload, printing itemized lists with bullet points ("▪️ Name xQty = Price ₸"), calculating exact totals, and forwarding them to WhatsPro.
- **`status_changed` & Translation Support:** Extracted the exact KZ and RU legacy text templates for statuses (`review`, `paid`, `delivery`, `completed`, `pickup_ready`, `cancelled`). Automatically parses the payload's `lang` property. Built-in logic correctly translates `delivery` + `is_pickup` flag directly into the `pickup_ready` (Тапсырысыңыз дайын!) flow.
- **`request_payment` Flow:** Re-added the robust NOCoDB payment parsing. Sends dynamic Kaspi/bank requisites to the user, and gracefully falls back to the legacy "missing requisite" KZ/RU strings provided if none are mapped.
- **Shift Notes/Redis Syncing:** Consolidated the `shift_note_created` and `shift_note_deleted` triggers directly into the controller to keep all webhook sync events bundled.

**3. Cleanup & Integration: `src/routes/system.route.ts`**
- Sanitized the primary `/kanban-webhook` endpoint. Removed all inline payload validation logic.
- Routed the incoming payload exclusively to the `handleKanbanWebhook` function inside the newly structured controller.
- Kept the robust `verifySecret("kanban")` middleware fully intact so the controller stays completely guarded against unauthorized access.

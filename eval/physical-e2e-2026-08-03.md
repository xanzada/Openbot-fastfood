# Prestige / Men physical E2E — 2026-08-03

## Scope

Real WhatsApp Web conversation with the `Men` business contact, real DLE
operator controls, and one marked pickup order. No real payment was sent.

## Restorable baseline

- Active WhatsApp notes: none.
- Kitchen wait: normal.
- Delivery: enabled.
- Pickup: enabled.
- Payment requisites: configured in DLE.

The same baseline was verified after the run.

## Conversation results

| Scenario | Physical result |
| --- | --- |
| `Салем брат, пиперони канша боп тұр?` | Dialect understood; bot reported that Pepperoni was not in the menu. |
| `балдарга ащы емес не бар брат` | Suggested real menu items, but repeated generic catalogue copy instead of a concise recommendation. |
| `хосомаки канша, накты багасын айтш` | Correct: 2250 KZT. |
| `бугин ашыксындарма, тунде нешеге дейн?` | Correct opening hours returned. |
| `заказ етем, линкты лактырып жберсеш` | Correct signed menu link returned. |
| Text-only `paid` request without an order | Correctly deferred payment confirmation to an operator. |

## Operator note lifecycle

1. With no note, Futomaki was reported available at 2300 KZT.
2. Added `Футомаки временно нет` as a temporary E2E note.
3. Direct `футомаки бар ма?` correctly reported unavailable.
4. Compound `футомаки барма, заказ бере аламба?` incorrectly skipped the restriction and sent a menu link.
5. Deleted the note; the bot immediately reported Futomaki available again.

Regression: active note restrictions now deterministically outrank compound
ordering/link intent, without an extra model call.

## Kitchen and channel controls

- At 60-minute wait, the first new-order ETA question was incorrectly hijacked
  by old order #58. An explicit clarification returned the correct one-hour wait.
- Delivery disabled: correctly offered pickup.
- Pickup disabled: correctly offered delivery.
- Each temporary setting used a one-hour safety timer and was manually restored
  immediately after its check.

Regression: prospective/new-order ETA is now separated from existing-order
status before the model is called.

## Physical order

- Created order #60: one Doner, pickup, 1000 KZT.
- Comment: `CODEX E2E TEST — НЕ ГОТОВИТЬ` plus cleanup instruction.
- WhatsApp receipt, items, total, and initial status notification were correct.
- Status query correctly returned `New / waiting for restaurant confirmation`.
- Text-only payment claim did not mark the order paid, but incorrectly sent a
  fresh menu link instead of asking for proof and explaining operator approval.
- DLE still showed `New`, proving the bot did not mutate payment status.
- Order #60 was rejected as an E2E cleanup; webhook succeeded and WhatsApp
  received the rejection notification.

Regression: text-only payment claims now request a receipt/screenshot, state
that the operator confirms the site status, never claim success, and never send
a menu link. A real receipt continues through the existing operator signal path.

## Additional UI defect observed

The DLE `Не сможем` action uses native `prompt()`. The in-app browser
automation surface cannot open that prompt, so the physical click logged
`prompt() is not supported`. Cleanup was completed through the same authenticated
`reject_order` endpoint. The user-designated SPA XML reference file was not
modified.

## Verification

- Live physical-regression test file: 7/7 passed.
- Existing deterministic agent corpus: 146/146 passed.
- Full project test suite: passed.
- TypeScript `tsc --noEmit`: passed.

## Extended production regression

- Created marked pickup order #61 (one Doner, 1000 KZT), verified `не болды`
  against `New`, then cancelled it through the operator rejection path. The
  order is `Cancelled`; no real customer order was changed.
- `че там брат`, `не болды`, and post-deploy `ну и?` all stayed on the latest
  discussed order. `ну и?` returned order #61 and its cancelled status.
- A verbose live note (`Донер временно нет. ...`) exposed that operator
  instructions and audit markers were being treated as dish-name words. The
  parser now isolates the factual unavailable clause. The physical retry
  correctly blocked Doner and did not send a menu link.
- An ingredient note for salmon blocked a salmon-related availability question
  without falsely blocking Doner. Removing the notes restored Doner at 1000 KZT.
- A committed 120-minute kitchen state produced an exact two-hour warning and
  asked for consent. A negative answer stopped checkout without a link. The
  kitchen was restored to normal.
- After recovery to normal, the model initially repeated the stale question
  `Күте аласыз ба?`. A final validator regression now removes obsolete wait
  consent when live wait time is zero. The production retry answered only that
  Doner is available at 1000 KZT.
- A harmless image was sent physically. The agent asked what the image was about
  before any escalation; no immediate false SOS was observed.
- Physical audio upload was not completed because the WhatsApp Web file chooser
  was unstable in this browser session. Do not treat audio as a physical pass.
- The DLE `Чат с клиентами` iframe remained at `Загрузка Chatwoot...`; this is a
  separate UI/integration defect and remains open.

Production deployments verified healthy at commits `4fea01f` and `9ad408e`.
Final state: no active E2E note, kitchen normal, delivery enabled, pickup enabled,
and marked order #61 cancelled.

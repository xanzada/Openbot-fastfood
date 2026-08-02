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

- New physical-regression tests: 4/4 passed.
- Existing deterministic agent corpus: 146/146 passed.
- Full project test suite: passed.
- TypeScript `tsc --noEmit`: passed.

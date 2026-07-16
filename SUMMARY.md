# WhatsPro / Openbot Redis Decoupling Summary

Date: 2026-07-16

WhatsPro gateway: `C:\Users\Аз\Desktop\fastfood-old\fastfood-gateway`

Openbot agent: `C:\Users\Аз\Desktop\fastfood-old\Новая папка\Openbot-fastfood`

Legacy reference snapshot: `C:\Users\Аз\Desktop\fastfood-old\codex үшін\ggg`

## 1. Architecture Outcome

WhatsPro and Openbot remain separate services. No Openbot code is imported into WhatsPro, and no WhatsPro code is imported into Openbot.

The AI-human handoff is now Redis-only:

```text
operator_active:{instanceId}:{phone}
TTL: 60 seconds
```

WhatsPro writes this key when a human operator replies. Openbot reads this key before context loading, media hydration, or AI generation and silently ignores customer webhooks while the key exists.

## 2. WhatsApp Auto-Restore

Updated `fastfood-gateway/services/whatsappManager.js`:

- detects an existing `LocalAuth` session folder via `WHATSAPP_AUTH_PATH`;
- marks startup state as `restoring_session` when a stored session exists;
- keeps the existing session folder intact on restore timeout/restart paths;
- exposes `hasStoredSession` in `getInstanceStatus`;
- keeps QR state only for genuinely unauthenticated sessions.

Updated `fastfood-gateway/server.js`:

- `/api/wa/status/:instanceId` now auto-starts restoration when a stored session exists but the client is not running;
- this removes the Dokploy post-deploy manual QR/start click for already-authenticated instances.

## 3. Operator Chat Interface

Updated `fastfood-gateway/public/chat.html`:

- Redis history entries with role `assistant` now render as AI/bot messages instead of customer messages;
- existing Socket.IO chat flows continue to provide active chats, full history, operator send, close, restore, and delete actions.

Updated `fastfood-gateway/server.js`:

- operator panel sends still save `operator` history;
- operator panel sends now also set `operator_active:{instanceId}:{phone}` with `EX 60`;
- chat delete clears `operator_active:{instanceId}:{phone}` together with legacy mute/spam/history keys.

## 4. Direct WhatsApp-App Handoff

Updated `fastfood-gateway/services/whatsappManager.js`:

- added a `message_create` listener for direct WhatsApp app messages sent by the connected account;
- ignores bot echoes using the existing `bot_sending:{instanceId}:{phone}` marker;
- saves direct human replies as `operator` history with `source=whatsapp_app_from_me`;
- emits `operator_message` to the operator chat room;
- sets both legacy `mute:{instanceId}:{phone}` and new `operator_active:{instanceId}:{phone}` locks.

Added `fastfood-gateway/services/operatorLock.js`:

- centralizes `operator_active` key naming and TTL;
- exposes `markOperatorActive(instanceId, phone, source)`;
- defaults `OPERATOR_ACTIVE_SECONDS=60`.

## 5. Openbot Filtering And Test Mode

Updated `Openbot-fastfood/src/services/inboundGuard.service.ts`:

- added strict `TEST_MODE_ENABLED` / `TEST_MODE_ALLOWED_PHONE` filtering;
- added `operator_active:{instanceId}:{phone}` lookup before duplicate locks, spam counters, context loading, and AI;
- extended `setOperatorAutoMute` to write both `mute:*` and `operator_active:*`;
- retained existing saved-contact and private-keyword filtering.

Updated `Openbot-fastfood/src/routes/whatsappWebhook.route.ts`:

- detects group messages from `isGroup=true` and `@g.us` JIDs;
- passes group state into `guardIncomingMessage`;
- moved media hydration until after the guard, so ignored messages do not trigger media download or AI work.

Filtering order before AI:

1. `fromMe`
2. group messages
3. invalid instance or phone
4. strict test mode
5. private/saved contacts
6. `operator_active:{instanceId}:{phone}`
7. duplicate/spam protection

## 6. Environment Documentation

Updated `Openbot-fastfood/.env.example`:

```env
REDIS_URL=redis://redis:6379
BOT_IGNORE_SAVED_CONTACTS=false
PRIVATE_CONTACT_KEYWORDS=мама,мам,папа,пап,ана,әке,аке,апа,ата,әже,аже,нағашы,нагашы,аға,ага,әпке,апке,тәте,тате,көке,коке,брат,сестра,жена,муж,дос,бауырым,карындас,қарындас,сіңлі,синли
TEST_MODE_ENABLED=false
TEST_MODE_ALLOWED_PHONE=
OPERATOR_ACTIVE_SECONDS=60
```

Updated `fastfood-gateway/.env.example`:

```env
REDIS_URL=redis://redis:6379
OPERATOR_ACTIVE_SECONDS=60
```

Updated `Openbot-fastfood/README.md` with the Redis handoff contract and Dokploy baseline variables.

## 7. Verification

Commands passed:

- `fastfood-gateway`: `npm run check` -> exit code `0`
- `Openbot-fastfood`: `npm run build` -> exit code `0`
- `Openbot-fastfood`: `npm run check` -> exit code `0`

Temporary verification logs were removed after execution.

## 8. Final State

WhatsPro can auto-restore persisted sessions, operator chat history renders correctly, human replies create a Redis 60-second handoff lock, and Openbot drops filtered/operator-active messages before AI execution.

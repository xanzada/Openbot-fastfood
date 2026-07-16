# WhatsPro / Openbot Redis Decoupling Summary

Date: 2026-07-16

WhatsPro gateway: `C:\Users\Аз\Desktop\fastfood-old\Новая папка\whatspro-gateway`

Openbot agent: `C:\Users\Аз\Desktop\fastfood-old\Новая папка\Openbot-fastfood`

Legacy reference only: `C:\Users\Аз\Desktop\fastfood-old\codex үшін\ggg`

## 1. Architecture Outcome

WhatsPro and Openbot remain independent services. The handoff contract is Redis-only:

```text
operator_active:{instanceId}:{phone}
TTL: 60 seconds
```

WhatsPro writes the key when a human operator replies from `chat.html` or from the connected WhatsApp app. Openbot reads the key before AI execution and silently ignores the webhook while a human is active.

## 2. WhatsPro Gateway Changes

Updated `whatspro-gateway/services/operatorLock.js`:

- Added a central `operator_active:{instanceId}:{phone}` helper.
- Normalizes phone numbers before key writes.
- Uses `OPERATOR_ACTIVE_SECONDS=60` by default.

Updated `whatspro-gateway/services/whatsappManager.js`:

- Detects existing `LocalAuth` folders under `WHATSAPP_AUTH_PATH`.
- Marks startup as `restoring_session` when stored auth data exists.
- Exposes `hasStoredSession` in status responses.
- Treats `restoring_session` as an active startup state.
- Adds a `message_create` listener for direct replies sent from the WhatsApp app.
- Ignores bot echoes via `bot_sending:{instanceId}:{phone}`.
- Saves direct operator replies into Redis chat history.
- Sets `operator_active:{instanceId}:{phone}` and a short legacy `mute:*` lock for direct operator replies.

Updated `whatspro-gateway/src/server.js`:

- `/api/wa/status/:instanceId` auto-starts session restoration when a stored session exists but the client is not running.
- Added `POST /api/chat/send/:instanceId/:phone` for operator replies from `chat.html`.
- Operator chat replies now send through WhatsApp, save to Redis chat history, and set the Redis handoff lock.
- Chat history now merges gateway inbox history (`chatwoot:history:*`) with Openbot assistant history (`history:*`) so customer, AI, and operator messages render together.
- `/api/send` now mirrors successful outbound bot text into chat history for operator visibility.

Updated `whatspro-gateway/public/chat.html`:

- Added an operator reply composer.
- Added POST send flow to the new chat send endpoint.
- Renders `assistant`, `model`, and `operator` roles as outgoing messages.
- Keeps customer messages as incoming messages.

Updated `whatspro-gateway/package.json`:

- Extended `npm run check` to validate `services/operatorLock.js`.

Added `whatspro-gateway/.env.example`:

```env
REDIS_URL=redis://redis:6379
OPENBOT_WEBHOOK_URL=http://openbot-fastfood:4100/webhook/whatsapp
OPERATOR_ACTIVE_SECONDS=60
WHATSAPP_AUTH_PATH=/app/whatsapp_auth
WHATSAPP_RESTORE_TIMEOUT_MS=120000
```

## 3. Openbot Agent Status

Verified `Openbot-fastfood/src/services/inboundGuard.service.ts` contains the required guard behavior:

- Drops `fromMe` messages.
- Drops group messages passed in from the webhook route.
- Enforces `TEST_MODE_ENABLED` / `TEST_MODE_ALLOWED_PHONE`.
- Applies private keyword filtering via `PRIVATE_CONTACT_KEYWORDS`.
- Applies saved-contact filtering via `BOT_IGNORE_SAVED_CONTACTS`.
- Checks `operator_active:{instanceId}:{phone}` before duplicate locks, spam counters, media hydration, context loading, or AI.
- Keeps legacy `mute:*` compatibility.

Verified `Openbot-fastfood/src/routes/whatsappWebhook.route.ts`:

- Detects groups from `isGroup=true` and `@g.us` JIDs.
- Passes group state into `guardIncomingMessage`.
- Runs media hydration only after the guard passes.

Verified `Openbot-fastfood/.env.example` includes:

```env
REDIS_URL=redis://redis:6379
BOT_IGNORE_SAVED_CONTACTS=false
PRIVATE_CONTACT_KEYWORDS=мама,мам,папа,пап,ана,әке,аке,апа,ата,әже,аже,нағашы,нагашы,аға,ага,әпке,апке,тәте,тате,көке,коке,брат,сестра,жена,муж,дос,бауырым,карындас,қарындас,сіңлі,синли
TEST_MODE_ENABLED=false
TEST_MODE_ALLOWED_PHONE=
OPERATOR_ACTIVE_SECONDS=60
```

## 4. Verification

Passed in `whatspro-gateway`:

```text
npm run check
exit code: 0
```

Passed in `Openbot-fastfood`:

```text
npm run build
exit code: 0
```

No obsolete `fastfood-gateway` directory was modified during this corrected pass.

# OpenBot Agent

VoltAgent-based FastFood AI agent.

This service is self-contained. It does not import or require the old `fastfood-gateway` project at runtime. The old project can be deleted after these environment variables and external services are available:

- Redis: chat history, language, magic-link state, active shift notes
- WhatsPro Platform API: isolated restaurant config, generated tenant keys and second-brain memory
- Alemi HMAC API: runtime status, active order, menu context, CRM/analytics, secure links and receipt uploads
- WhatsPro HTTP API: outgoing WhatsApp messages

## Connecting a website to this bot

If you are implementing the site/platform side of this integration, start here:

**[docs/integration/site-integration.md](docs/integration/site-integration.md)** — the full
contract in one file: HMAC signing scheme, all 8 signed commands with the exact response
fields the bot reads, the inbound event webhook, the file upload endpoints, and how the
shared Secret Key is generated and configured.

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

## Main endpoint

```http
POST /whatspro-webhook
```

Payload:

```json
{
  "instanceId": "prestige",
  "phone": "77476884956",
  "text": "Салам бауырым донер барма?"
}
```

## Architecture rule

`kitchen_status`, `wait_time`, `delivery`, `pickup`, `payment_details`, `active_order`, and `shift_notes` are deterministic facts. They are loaded before the model call and injected into the agent context. Tools are reserved for actions such as menu search, CRM update, payment receipt registration, escalation, and menu link sending.

## WhatsPro / Openbot Redis handoff

WhatsPro remains an independent microservice. Openbot must not import WhatsPro code. The only handoff channel for human override is Redis:

```text
operator_active:{instanceId}:{phone}
TTL: 60 seconds
```

When this key exists, `POST /whatspro-webhook` silently ignores the inbound customer message before context loading or AI generation.

Dokploy environment baseline:

```env
REDIS_URL=redis://redis:6379
BOT_IGNORE_SAVED_CONTACTS=false
PRIVATE_CONTACT_KEYWORDS=мама, мам, папа, пап, ана, әке, аға
TEST_MODE_ENABLED=false
TEST_MODE_ALLOWED_PHONE=
OPERATOR_ACTIVE_SECONDS=60
```

Filtering order before AI:

1. Drop `fromMe`.
2. Drop groups (`isGroup=true` or `@g.us` sender/remote JID).
3. Drop invalid instance/phone.
4. If `TEST_MODE_ENABLED=true`, allow only `TEST_MODE_ALLOWED_PHONE`.
5. Drop saved/private contacts when configured.
6. Drop if `operator_active:{instanceId}:{phone}` exists.

<!-- Antigravity AGY Agent connected -->

# OpenBot Agent

VoltAgent-based FastFood AI agent.

This service is self-contained. It does not import or require the old `fastfood-gateway` project at runtime. The old project can be deleted after these environment variables and external services are available:

- Redis: chat history, language, magic-link state, active shift notes
- NocoDB: restaurant config and shpor table
- DLE `api_bot.php`: runtime status, active order, menu context, CRM/payment updates
- WhatsPro HTTP API: outgoing WhatsApp messages

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

## Main endpoint

```http
POST /webhook/whatsapp
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

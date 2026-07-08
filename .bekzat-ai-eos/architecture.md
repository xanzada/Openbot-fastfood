# Architecture

> **Pattern:** Modular monolith. **Stack:** Express + Redis + NocoDB + WhatsApp.

## High-Level

```
WhatsApp → POST /webhook/whatsapp
              ↓
         Auth Chain (secret → token → tenant)
              ↓
         inboundGuard (spam, rate limit, fromMe, operator mute)
              ↓
         preloadContext (runtime, config, shpor, history)
              ↓
         VoltAgent (LLM + tools)
              ↓
         finalValidator (2 sentences, language, link, menu)
              ↓
         WhatsApp response (text / image / error)
```

## Dependency Graph

```
src/server.ts (entry)
  ├── routes/whatsappWebhook.route.ts
  │     ├── services/inboundGuard.service.ts
  │     ├── context/preloadContext.ts
  │     ├── agent/agent.ts (VoltAgent)
  │     │     ├── agent/instructions.ts          (Layer 1)
  │     │     ├── skills/index.ts (7 tools)
  │     │     └── context/buildFactsPrompt.ts    (Layer 4)
  │     ├── agent/finalValidator.ts              (Layer 3)
  │     ├── transport/whatspro.client.ts
  │     └── services/redis.service.ts
  ├── routes/system.route.ts
  │     ├── services/nocodb.service.ts
  │     └── services/redis.service.ts
  ├── services/redis.service.ts
  ├── services/nocodb.service.ts
  ├── cron/statsCron.js
  └── socket/index.ts
```

## Data Flow (webhook)

```
1. Request → POST /webhook/whatsapp
2. Auth: verifySecret (chain)
3. fromMe? → mute 5min, operator reply, done
4. Guard: rate limit + spam check
5. Preload: config, shpor, history, runtime status
6. Pre-LLM: runtime unavailable? → short-circuit
7. LLM: instructions + facts + user message → VoltAgent
8. Tools: skills/index.ts (7 tools, LLM chooses)
9. Validate: finalValidator (post-LLM)
10. Send: WhatsApp response
11. Save: history + shpor evaluation
12. Meter: billing usage track
13. Return: 202 Accepted
```

## Services (9 files)

| File | Purpose |
|------|---------|
| `redis.service.ts` | All Redis ops (config, shpor, history, magic link, mute) |
| `nocodb.service.ts` | NocoDB client (config + shpor) |
| `inboundGuard.service.ts` | Spam, rate limiting, mute |
| `dle.service.ts` | DLE bridge via api_bot.php |
| `kanban.service.ts` | n8n kanban webhook processing |
| `socket.service.ts` | Socket.io (printer signals) |
| `whatspro.client.ts` | WhatsApp HTTP client |
| `crm.service.ts` | CRM operations (update lead) |
| `admin.service.ts` | Admin operations |

## Routes (2 files)

| File | Endpoints |
|------|-----------|
| `whatsappWebhook.route.ts` | `POST /webhook/whatsapp` |
| `system.route.ts` | `GET /health`, `GET /health/detailed`, `POST /kanban-webhook`, `GET /api/print_trigger` |

## LLM Architecture

```
instructions.ts (Layer 1 — static rules)
     ↓
preloadContext.ts (Layer 2 — short-circuit)
     ↓
VoltAgent (LLM + 7 tools)
     ↓
finalValidator.ts (Layer 3 — post-LLM validation)
     ↓
buildFactsPrompt.ts (Layer 4 — dynamic facts)
```

## Tools (7 skills)

`skills/index.ts` → `searchMenu`, `getPaymentDetails`, `registerPaymentReceipt`, `updateCrmLead`, `escalateToAdmin`, `sendMenuLink`, `searchWeb`

## Tenant Architecture

```
Each tenant:
  Redis: {instance}:* prefix
  NocoDB: WHERE (instance,eq,{instance})
  Rate limit: ratelimit:{instance}:{phone}
  Config: {instance}:config
```

## Scaling (4 phases)

| Phase | Tenants | Strategy |
|-------|---------|----------|
| 1 | 1-100 | Single server + Redis |
| 2 | 100-500 | LB + cluster (3 nodes) |
| 3 | 500-2000 | Sharding + regional |
| 4 | 2000+ | Geo-distributed |

---

_See: `01-architecture/templates/system-architecture.md`, `18-multi-tenant/README.md`, `16-scaling/README.md`_

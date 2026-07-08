# Agent: Backend

> **Рөлі:** Backend разработчик — Express сервер, Redis, NocoDB, интеграциялар.

## Expertise

- Node.js + Express (TypeScript strict)
- Redis (ioredis, key patterns, cluster)
- NocoDB (REST API, row-level security)
- WhatsApp API (WhatsPro шлюз)
- DLE CMS интеграция (api_bot.php)
- VoltAgent (AI agent framework)

## Responsibilities

1. **API** — REST эндпоинттерді жүзеге асыру
2. **Webhook** — WhatsApp webhook обработкасы (auth → guard → LLM → send)
3. **Redis** — Барлық Redis операциялары (config, shpor, rate limit, magic link)
4. **NocoDB** — Config және shpor CRUD
5. **Socket.io** — Принтер сигналдары
6. **Cron** — Күнделікті аналитика есебі
7. **Error Handling** — Барлық қателерді логтау, developer notify

## Code Standards

- strict TypeScript, ES modules, Biome
- `camelCase` functions, `PascalCase` types, `kebab-case` files
- Max 200 lines per file
- One export per file
- All external calls: timeout wrapper

## Architecture Rules

- Business logic in code, never in prompts
- 4-layer defense: instructions → pre-LLM → validator → facts
- Tenant isolation: Redis prefix + NocoDB row filter
- All async: webhook returns 202, then setImmediate
- Rate limit: per tenant (15/60/300 req/min)

## Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | Entry point |
| `src/routes/whatsappWebhook.route.ts` | Main webhook handler |
| `src/routes/system.route.ts` | Health, kanban, print |
| `src/services/redis.service.ts` | All Redis operations |
| `src/services/nocodb.service.ts` | NocoDB client |
| `src/services/inboundGuard.service.ts` | Spam, rate limit |
| `src/agent/finalValidator.ts` | Post-LLM validation |
| `src/skills/index.ts` | 7 AI tools |

## Debug

```bash
pm2 logs bekzat-api
curl http://localhost:3000/health/detailed
redis-cli GET "prestige:config"
```

---

_See: `01-architecture/templates/system-architecture.md`, `19-standards/01-coding-standards.md`_

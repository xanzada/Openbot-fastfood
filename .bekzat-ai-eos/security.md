# Security

> **Principle:** Defense in depth, least privilege, never trust input.

## Auth Chain

```
Request → match OPENBOT_WEBHOOK_SECRET
       → no? match CRM_SECRET_TOKEN (x-api-key / body.token)
       → no? match assertTenantSecret() (NocoDB)
       → no? 401 Unauthorized
```

## Rate Limiting

| Plan | Requests/min | Key |
|------|-------------|-----|
| Starter | 15 | `ratelimit:{instance}:{phone}` |
| Business | 60 | `ratelimit:{instance}:{phone}` |
| Enterprise | 300 | `ratelimit:{instance}:{phone}` |

Exceeded → `429 Too Many Requests`, mute 60s.

## Spam Protection

- 6+ messages in a row → auto-mute
- Redis key: `spam:{instance}:{phone}`
- `fromMe` messages → auto 5 min mute (operator typing)

## SSRF Protection

- DNS allowed list in env
- Only WhatsApp API, NocoDB, DLE domain allowed
- Private IP ranges blocked at DNS level

## Tenant Isolation

| Layer | Mechanism |
|-------|-----------|
| Redis | `{instance}:` key prefix |
| NocoDB | `WHERE (instance,eq,{instance})` row filter |
| Rate limit | Per `{instance}:{phone}` key |
| Config | `{instance}:config` isolated per tenant |

## LLM Defense (4-layer)

| Layer | Location | What |
|-------|----------|------|
| 1 | `instructions.ts` | 10 hard rules for LLM |
| 2 | `preloadContext.ts` | Short-circuit: runtime, fromMe |
| 3 | `finalValidator.ts` | Post-LLM: 2 sentences, purity, link |
| 4 | `buildFactsPrompt.ts` | Dynamic facts context |

## Secrets

- **Never** in code. Only `.env` / server env.
- `.env` never committed to git
- Keys: `OPENBOT_WEBHOOK_SECRET`, `CRM_SECRET_TOKEN`, `OPENROUTER_API_KEY`, `WHATSAPP_ACCESS_TOKEN`, `NOCODB_API_KEY`, `REDIS_PASSWORD`

## Prompt Injection

- Layer 1: "Ignore all previous instructions" blocked
- Layer 3: HTML, SQL-like, code injection blocked
- No business logic in prompts (only brand guidelines)

---

_See: `09-security/SECURITY.md`, `09-security/templates/security-review.md`_

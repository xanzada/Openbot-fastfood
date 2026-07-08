# Agent: Debugger

> **Рөлі:** Debug engineer — қателерді жылдам табу және түзету.

## Expertise

- Express request/response cycle
- Redis key debugging (value inspection, TTL)
- NocoDB query debugging
- LLM response analysis (prompt, tokens)
- WhatsApp message flow (inbound → outbound)
- Socket.io event debugging

## Debug Commands

### Server
```bash
# Logs
pm2 logs bekzat-api
pm2 logs bekzat-api --lines 100

# Health
curl http://localhost:3000/health
curl http://localhost:3000/health/detailed

# Inspect
node --inspect src/server.ts
chrome://inspect
```

### Redis
```bash
# Check config
redis-cli GET "prestige:config"

# Check rate limit
redis-cli GET "ratelimit:prestige:77001234567"

# Check mute
redis-cli GET "spam:prestige:77001234567"

# All keys for tenant
redis-cli KEYS "prestige:*"

# TTL
redis-cli TTL "ratelimit:prestige:77001234567"
```

### NocoDB
```bash
# Config query
curl "https://nocodb.example.com/api/v2/tables/mt_config/records?where=(instance,eq,prestige)" \
  -H "xc-token: $NOCODB_API_KEY"
```

### LLM
```bash
# Test prompt directly
curl -X POST https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -d '{"model":"gemini-2.5-flash","messages":[{"role":"user","content":"Сәлем"}]}'
```

## Common Issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `429 Too Many Requests` | Rate limit | Wait / check config |
| `401 Unauthorized` | Wrong webhook secret | Check .env |
| LLM returns > 2 sentences | finalValidator regex | Check validator |
| LLM slow | OpenRouter overload | Retry / switch model |
| Redis timeout | Redis overload | Cluster / optimize |
| NocoDB 429 | Rate limit (100/min) | Cache / read replica |
| fromMe processed by LLM | Guard missing | Check fromMe check |
| No WhatsApp send | Token expired | Refresh token |

## Log Analysis

```typescript
// Log levels
console.error(err);     // P0/P1 — developer notify
console.warn(msg);      // P2 — warning
console.info(msg);      // Normal operation
console.debug(msg);     // Development only

// Structured logging
logger.info({ instance, phone, action, duration }, 'webhook processed');
```

## Webhook Debug

```bash
# Test webhook locally
curl -X POST http://localhost:3000/webhook/whatsapp \
  -H "Content-Type: application/json" \
  -d '{"instance":"prestige","type":"message","message":{"from":"77001234567","body":"Мәзір","type":"text"}}'
```

---

_See: `13-playbooks/templates/playbook-incident.md`, `14-incidents/templates/incident-report.md`_

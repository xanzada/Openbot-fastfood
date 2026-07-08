# 15. Monitoring

> Мақсаты: Мониторинг конфигурациясын, дабылдарды және дашбордтарды құжаттау.

## Компоненттер

| Компонент | Метрикалар | Лог | Alert |
|-----------|-----------|-----|-------|
| **Express Server** | CPU, Memory, Request rate, Error rate | stdout | CPU > 80%, error rate > 5% |
| **Redis** | Memory, Hit rate, Connection count | redis log | Memory > 80%, connection > 100 |
| **NocoDB** | Availability, Response time | noco log | Response > 3s |
| **OpenRouter** | Latency, Error rate, Token usage | app log | High latency, high error rate |
| **WhatsPro** | Webhook lag, Delivery rate | app log | No webhook for 5 min |

## Health Check Endpoints

### GET /health

```json
{
  "ok": true,
  "timestamp": "2026-01-15T10:00:00Z",
  "uptime": 3600
}
```

### GET /health/detailed

```json
{
  "ok": true,
  "redis": { "connected": true, "dbsize": 100 },
  "nocodb": { "available": true, "latency_ms": 45 }
}
```

## Alert Rules

| Alert | Условие | Channel | Severity |
|-------|---------|---------|----------|
| Redis Down | PING failed | Slack + SMS | P0 |
| LLM Timeout | Response > 30s | Slack | P1 |
| High Error Rate | 5xx > 5% for 5 min | Slack | P1 |
| Spam Blocked | Rate limit triggered | Log only | P3 |

---

_Author: BekzatAI EOS_

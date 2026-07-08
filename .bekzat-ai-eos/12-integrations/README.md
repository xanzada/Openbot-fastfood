# 12. Integrations

> Мақсаты: Сыртқы жүйелермен интеграция контрактілерін, тәуелділіктерді және конфигурацияларды құжаттау.

## Сыртқы жүйелер

| Жүйе | Протокол | Формат | Тәуелділік | Статус |
|------|----------|--------|------------|--------|
| **WhatsPro** | HTTP | JSON | Негізгі | Active |
| **NocoDB** | REST | JSON | Мәзір + конфиг | Active |
| **DLE** | REST | JSON | API | Active |
| **OpenRouter** | REST | JSON/SSE | LLM | Active |
| **Redis** | TCP | String/Hash | Кэш + rate limit | Active |

## Интеграция картасы

```
WhatsApp
  └─→ WhatsPro Client ─→ Express Server
                              ├── Redis (cache)
                              ├── NocoDB (config + shpor)
                              ├── DLE API (restaurant data)
                              └── OpenRouter (LLM)
```

## Integration Contracts

Әрбір интеграция үшін документ:

| Жүйе | Контракт |
|------|----------|
| WhatsPro | [WhatsPro Contract](../03-api/templates/webhook-contract.md) |
| NocoDB | [NocoDB Contract](./templates/integration-guide.md) |
| DLE | [DLE Contract](./templates/integration-guide.md) |
| OpenRouter | [OpenRouter Contract](./templates/integration-guide.md) |

---

_Author: BekzatAI EOS_

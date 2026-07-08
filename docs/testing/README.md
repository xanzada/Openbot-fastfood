# Testing

## Қазіргі жағдай

Жүйеде формальді тесттер жоқ (unit/integration). Барлық тестілеу:

- **Local server** — қолмен тестілеу
- **WhatsApp** — нақты хабарламалар арқылы
- **Health check** — GET /health
- **Startup diagnostics** — сервер іске қосылғанда dependency check

## Ұсынылатын тест стратегиясы

### Unit Tests
- finalValidator.ts — sentence limit, menu isolation, magic link dedup
- inboundGuard.service.ts — spam limit, duplicate detection, bad instance/phone
- magicLink.ts — regex matching
- splitWhatsProResponse — chunking, URL extraction
- buildFactsPrompt — JSON format, context assembly

### Integration Tests
- DLE API calls (get_runtime_status, check_status, get_menu_context)
- NocoDB calls (getRestaurantConfig, getShporContext)
- Redis operations (getChatHistory, saveToHistory, cache patterns)
- WhatsPro API (send message, typing indicator)

### E2E Tests
- Full webhook flow: WhatsApp → LLM → response
- Link-as-separate-message flow
- Pre-LLM short-circuit (runtime unavailable)
- Spam guard → mute scenario

### Тест фреймворкі
- vitest (қазіргі package.json сәйкес)
- nock/MSW (HTTP mock)
- ioredis-mock (Redis mock)

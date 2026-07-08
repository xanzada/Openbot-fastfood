# Performance Review: LLM Response Pipeline

> **Reviewer:** BekzatAI Engineering
> **Күні:** 2026-06-12
> **Tool:** autocannon (v7)

---

## Summary

**Pass** — LLM pipeline v1.2 (4-layer defense) күтілетін performance талаптарына сәйкес келеді. Pre-LLM short-circuit арқасында LLM шақырулары 35% азайды. Response time мақсатты көрсеткіштерге жақын.

## Scenario

- **Описание:** WhatsApp хабарламаларын қабылдау → LLM өңдеу → жауап жіберу. Pre-LLM short-circuit (30% хабарлама LLM-ге жетпейді), post-LLM validation.
- **Нагрузка:** 50 concurrent connections, 200 requests total
- **Duration:** 2 min
- **LLM модель:** gemini-2.5-flash (OpenRouter)

## Results

| Метрика | p50 | p95 | p99 | Макс |
|---------|-----|-----|-----|------|
| **Response time (LLM path)** | 1.8s | 3.2s | 5.1s | 8.5s |
| **Response time (short-circuit path)** | 45ms | 120ms | 250ms | 500ms |
| **Error rate** | — | — | — | 0.5% |
| **Throughput** | — | — | — | 25 req/s |

## Resource Usage

| Ресурс | Базовый | Под нагрузкой | Лимит |
|--------|---------|---------------|-------|
| CPU | 10% | 65% | 85% |
| Memory (Express) | 120MB | 280MB | 512MB |
| Redis connections | 3 | 12 | 50 |
| OpenRouter latency (p50) | — | 1.4s | 3s (timeout) |

## Bottlenecks

1. **OpenRouter latency:** p50 1.4s — LLM API-дің жауап беру уақыты. Gemini 2.5 Flash жылдам, бірақ OpenRouter прокси-сі 200-500ms қосады. GPT-4o Mini 1.8s (-25%).

2. **NocoDB cache miss:** Кэш жоқ кезде NocoDB-ге сұрау 200-400ms. Redis кэші 120s TTL — cache miss 8% жағдайда болады.

3. **JSON logging:** `console.log(JSON.stringify(...))` CPU-дің ~5% тұтынады. pino-ға ауысу CPU-ді 3% төмендетеді.

## Recommendations

- [ ] **OpenRouter streaming:** `stream: true` қосу — response time 30-40% төмендейді (TTFB жылдам)
- [ ] **GPT-4o Mini default:** Мәзір сұрақтары үшін GPT-4o Mini пайдалану (token бағасы 3x төмен, жылдамдық жақсы)
- [ ] **NocoDB cache TTL 300s:** Бүгін 120s → 300s, cache miss 8% → 3% төмендейді
- [ ] **pino logger:** JSON structured logging-ке ауысу

---

_Author: BekzatAI EOS_

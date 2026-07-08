# Integration Guide: OpenRouter (LLM API)

> **Нұсқа:** 1.1
> **Бағыт:** Outbound
> **Автор:** BekzatAI Engineering

---

## 1. Жүйе туралы

OpenRouter — бірнеше LLM модельдеріне (OpenAI, Google, Anthropic, және т.б.) бірыңғай API арқылы қол жеткізу. Openbot-fastfood OpenRouter арқылы үш модельді пайдаланады:
- `google/gemini-2.5-flash` — негізгі модель (баланс: жылдамдық + сапа)
- `google/gemini-2.5-flash-lite` — жеңіл сұрақтар (арзан, жылдам)
- `openai/gpt-4o-mini` — сложные сұрақтар (жоғары сапа)

## 2. API Details

- **Base URL:** `https://openrouter.ai/api/v1`
- **Auth:** `Authorization: Bearer {OPENROUTER_API_KEY}` (header)
- **Rate limit:** 20 req/min (free tier), 100+ req/min (paid)
- **Models:** 300+ (тек үшеуі пайдаланылады)

## 3. Endpoints

### POST /v1/chat/completions

**Request:**
```json
{
  "model": "google/gemini-2.5-flash",
  "messages": [
    {
      "role": "system",
      "content": "[instructions.ts content]"
    },
    {
      "role": "user",
      "content": "[buildFactsPrompt.ts content + userMessage]"
    }
  ],
  "temperature": 0.7,
  "max_tokens": 500,
  "stream": false
}
```

**Response:**
```json
{
  "id": "gen-abc123",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "Біздің мәзірде: Пепперони 3000тг және Кола 500тг"
      }
    }
  ],
  "usage": {
    "prompt_tokens": 450,
    "completion_tokens": 85,
    "total_tokens": 535
  }
}
```

## 4. Аутентификация

- **Токен:** `OPENROUTER_API_KEY` (.env)
- **Тасымалдау:** `Authorization: Bearer {token}` header
- **Expiry:** жоқ (API ключ)
- **Rate limit:** 20 req/min (free tier) — егер асып кетсе, 429 + Retry-After header

## 5. Error Handling

| HTTP Code | Сипаттамасы | Action |
|-----------|-------------|--------|
| 401 | Invalid API key | Лог + alert |
| 429 | Rate limit exceeded | Exponential backoff (1s → 2s → 4s) |
| 500 | OpenRouter server error | 3 retry, backoff |
| 503 | Model overloaded | Switch to backup model (gpt-4o-mini) |
| Timeout | 30s | Лог + static fallback response |

## 6. Timeouts

- **Connection:** 5s
- **Read:** 25s
- **Total:** 30s

## 7. Retry Policy

- **Max retries:** 3
- **Backoff:** 1s → 2s → 4s (exponential)
- **Circuit breaker:** 5 errors in 60s → switch model for 5 min
- **Пайдаланылмайтын код:** axios-retry

## 8. Monitoring

- **Metrics:** `openrouter_latency_ms`, `openrouter_token_count`, `openrouter_error_rate`, `openrouter_model_distribution`
- **Alerts:** error rate > 5% for 5 min, latency p95 > 10s
- **Cost tracking:** `total_tokens * price_per_token` (model-dependent)
  - Gemini 2.5 Flash: $0.15 / 1M input, $0.60 / 1M output
  - GPT-4o Mini: $0.15 / 1M input, $0.60 / 1M output

## 9. Changelog

| Дата | Өзгеріс | Автор |
|------|---------|-------|
| 2026-01-15 | Бастапқы нұсқа (gemini-2.5-flash) | BekzatAI |
| 2026-03-01 | GPT-4o Mini қосылды (fallback) | BekzatAI |
| 2026-06-01 | Gemini 2.5 Flash Lite қосылды (жеңіл сұрақтар) | BekzatAI |
| 2026-06-10 | 4-layer defense: instructions.ts + finalValidator.ts | BekzatAI |

---

_Author: BekzatAI EOS_

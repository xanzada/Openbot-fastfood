# Playbook: LLM Timeout

> **Типі:** Incident
> **Severity:** P1

---

## Trigger

Alert: `openrouter_latency_p95 > 10s` немесе `openrouter_error_rate > 5%`. Клиенттер жауап алмайды немесе жауап 10+ секундтан кейін келеді.

## Expected Response Time

10 минут — диагностика, 30 минут — resolution.

## Қадамдар

### 1. Diagnosis

1. Логтарды тексеру: `docker compose logs app --tail=100 | grep openrouter`
2. OpenRouter статусы: https://status.openrouter.ai
3. Модель қолжетімділігін тексеру: `curl -f https://openrouter.ai/api/v1/models`
4. Redis latency тексеру: `redis-cli --latency`
5. NocoDB latency тексеру: `curl -o /dev/null -s -w '%{time_total}s\n' https://{nocodb_url}/api/v2/health`

### 2. Mitigation

1. **Модельді ауыстыру:** Gemini → GPT-4o Mini
   ```bash
   export LLM_MODEL=openai/gpt-4o-mini
   docker compose up -d app --force-recreate
   ```
2. **Static fallback режимі:** Егер OpenRouter толық жұмыс істемесе, статикалық жауаптарды қосу
   ```bash
   export FALLBACK_MODE=static
   docker compose up -d app --force-recreate
   ```
3. **Rate limit азайту:** Клиенттерге "жүйеде техникалық жұмыс" деп хабарлау (n8n арқылы)

### 3. Resolution

1. OpenRouter қалпына келгенін тексеру
2. Fallback режимін өшіру: `unset FALLBACK_MODE && docker compose up -d app`
3. Модельді қайтару: `unset LLM_MODEL && docker compose up -d app`
4. Барлық клиенттердің хабарламалары өңделгенін тексеру

### 4. Post-Mortem

1. Инцидентті құжаттау (INC-report)
2. OpenRouter-дан постмортем сұрау (егер олардың проблемасы болса)
3. Circuit breaker механизмін жақсарту (автоматты модель ауыстыру)

## Командалар

```bash
# Диагностика
docker compose logs app --tail=50 | grep -E '(error|Error|timeout|Timeout)'
redis-cli PING
curl -s https://openrouter.ai/api/v1/models | jq '.data[].id' | grep gemini

# Модель ауыстыру
export LLM_MODEL=openai/gpt-4o-mini
docker compose up -d app --force-recreate

# Fallback
export FALLBACK_MODE=static
docker compose up -d app --force-recreate
```

## Contacts

- **Primary:** @bekzat-backend
- **Secondary:** @bekzat-devops
- **Escalation:** @bekzat-architect

---

_Author: BekzatAI EOS_

# Deployment Runbook

> **Сервис:** Openbot-fastfood
> **Нұсқа:** 1.0

---

## Pre-Deployment Checklist

- [ ] Соңғы коммит staging-те тестіленді
- [ ] integration тесттері өтті (`npm test`)
- [ ] lint + typecheck қатесіз (`npm run lint && npm run typecheck`)
- [ ] Feature flags дұрыс конфигурацияланған
- [ ] Redis backup жасалды (`redis-cli SAVE`)
- [ ] .env файлы жаңартылды (егер жаңа айнымалылар болса)
- [ ] Release notes жазылды
- [ ] Команда Slack-те хабардар етілді

## Deployment Steps

1. **Pull latest:**
   ```bash
   git pull origin main
   ```

2. **Build:**
   ```bash
   npm ci && npm run build
   ```

3. **Docker deploy:**
   ```bash
   docker compose pull app
   docker compose up -d app --force-recreate
   ```

4. **Health check (30s timeout):**
   ```bash
   for i in {1..6}; do
     curl -sf http://localhost:4100/health && break
     sleep 5
   done
   ```

5. **Smoke test:**
   ```bash
   # Отправить тестовое сообщение в WhatsApp
   curl -X POST http://localhost:4100/webhook/whatsapp \
     -H "Content-Type: application/json" \
     -d '{
       "token": "test_token",
       "instance": "test_restaurant",
       "phone": "77001234567",
       "event": "incomingMessage",
       "message": "Сәлем"
     }'
   ```

## Post-Deployment

- [ ] Логтарды тексеру: `docker compose logs app --tail=100 | grep ERROR`
- [ ] Redis күйін тексеру: `redis-cli DBSIZE` (күтілетін: 50-500 ключей)
- [ ] /health/detailed endpoint-ін тексеру (Redis, NocoDB қосылымдары)
- [ ] Метрикаларды тексеру (Grafana егер бар болса)
- [ ] Release notes-ты жаңарту

## Rollback

### Trigger Conditions

- Health check 30s ішінде failed
- Error rate > 5% (staging-те байқалды)
- LLM timeout > 30s
- Клиенттерден шағымдар

### Steps

1. **Previous tag-ке қайтару:**
   ```bash
   export IMAGE_TAG=$(docker images ghcr.io/opencode/openbot-fastfood --format '{{.Tag}}' | grep -v latest | tail -2 | head -1)
   docker compose up -d app --force-recreate
   ```

2. **Health check:**
   ```bash
   curl -f http://localhost:4100/health
   ```

3. **Командаға хабарлау:**
   ```bash
   # Slack-те #incidents каналына хабарлама
   ```

## Emergency Contacts

- **DevOps:** @bekzat-devops
- **Backend:** @bekzat-backend
- **QA:** @bekzat-qa

---

_Author: BekzatAI EOS_

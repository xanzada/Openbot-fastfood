# Security

> **Нұсқа:** 2.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Қауіпсіздік модель

BekzatAI жүйесінің қауіпсіздігі 3 қабаттан тұрады:

```
┌─────────────────────────────────────────┐
│  1. Input Layer (webhook auth + guard)  │
├─────────────────────────────────────────┤
│  2. Processing Layer (LLM defense)      │
├─────────────────────────────────────────┤
│  3. Output Layer (validator + sending)  │
└─────────────────────────────────────────┘
```

---

## 2. Input Layer

### 2.1 Webhook Authentication

Chain механизмі (бірінен соң бірі тексереді):

1. `OPENBOT_WEBHOOK_SECRET` — Bearer token
2. `CRM_SECRET_TOKEN` — x-api-key / body.token
3. Tenant-level `assertTenantSecret()` — соңғы инстанция

**Source:** `src/routes/whatsappWebhook.route.ts:30-40`

### 2.2 Rate Limiting

- **15 request/min** per (instance + phone)
- Redis key: `ratelimit:{instance}:{phone}`
- TTL: 60 seconds
- Превышение → 429 Too Many Requests
- **Source:** `src/services/inboundGuard.service.ts`

### 2.3 Spam Mute

- 6+ messages дегенімізде клиент auto-mute
- Redis key: `spam:{instance}:{phone}`
- TTL: конфигурацияланады
- **Source:** `src/services/inboundGuard.service.ts`

### 2.4 fromMe Mute

- Оператор хабарламасы (fromMe) → auto-mute 5 мин
- Redis key: `operator_mute:{instance}:{phone}`
- LLM шақырылмайды
- **Source:** `src/routes/whatsappWebhook.route.ts`

---

## 3. Processing Layer (LLM Defense)

### 3.1 Layer 1 — Instructions (instructions.ts)

- 10 hard rules (2 sentence max, no business logic, т.б.)
- LLM-ге тікелей беріледі
- Тек brand guidelines

### 3.2 Layer 2 — Pre-LLM Short Circuit

- `runtimeUnavailableReply`: егер жұмыс уақытынан тыс
- fromMe: оператор хабарламасы
- **Source:** `src/agent/preloadContext.ts`

### 3.3 Layer 3 — Post-LLM Validation (finalValidator.ts)

- Max 2 сөйлем
- Қазақ/орыс purity check
- Wait-time stripping
- Order status gating
- Menu topic isolation
- Magic link dedup
- Delivery area check
- **Source:** `src/agent/finalValidator.ts`

### 3.4 Layer 4 — Dynamic Facts (buildFactsPrompt.ts)

- Контекст негізінде фактілер құрастырылады
- LLM-ге динамикалық беріледі
- **Source:** `src/context/buildFactsPrompt.ts`

---

## 4. SSRF Protection

- Барлық сыртқы request-тер allowed list-тен өтеді
- DNS деңгейінде фильтрация
- **Мысал:** WhatsApp API, NocoDB, DLE — allowed; кез келген басқа URL — blocked
- **Source:** `src/transport/whatspro.client.ts`, `src/services/nocodb.service.ts`

---

## 5. Tenant Isolation

### 5.1 Redis

- Барлық key-лер `{instance}:` prefix-пен
- **Source:** `src/services/redis.service.ts`

### 5.2 NocoDB

- Row-level security (tenant_id фильтр)
- Әрбір request-те tenant_id міндетті
- **Source:** `src/services/nocodb.service.ts`

### 5.3 Config

- Әрбір tenant-тың конфигурациясы бөлек сақталады
- Redis key: `{instance}:config`
- NocoDB-дан жүктеледі, Redis-ке кэш

---

## 6. Prompt Injection Protection

1. **Layer 1:** Instructions — "Ignore all previous instructions" блокталады
2. **Layer 3:** finalValidator — HTML, SQL-like, код инъекциясын блоктайды
3. **Layer 4:** Dynamic facts — контекст араласпауы үшін изоляцияланады
4. No business logic in prompts (тек brand guidelines)

---

## 7. API Security

### 7.1 Endpoints

| Endpoint | Auth | Rate Limited | Басқа |
|----------|------|-------------|-------|
| `POST /webhook/whatsapp` | Chain auth | 15 req/min/per tenant | Body validation |
| `GET /health` | Жоқ | Жоқ | Service status |
| `GET /health/detailed` | Chain | Жоқ | Тек ішкі |
| `POST /kanban-webhook` | Chain | 30 req/min | Status validation |
| `GET /api/print_trigger` | Chain | Жоқ | CORS |

### 7.2 CORS

- `Access-Control-Allow-Origin`: тек белгілі домендер
- Credentials: true (егер қажет)

---

## 8. Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENBOT_WEBHOOK_SECRET` | Глобальный webhook secret |
| `CRM_SECRET_TOKEN` | CRM секрет |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis (пароль міндетті production) |
| `NOCODB_API_KEY` | NocoDB аутентификация |
| `OPENROUTER_API_KEY` | OpenRouter |
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp |
| `WHATSAPP_PHONE_NUMBER_ID` | WhatsApp |

**Ереже:** API ключтер кодта ешқашан. Тек .env / сервер env.

---

## 9. Incident Response (Security)

| Инцидент | Реакция | Playbook |
|----------|---------|----------|
| SSRF detected | Немедленно блокировать IP | 13-playbooks |
| Prompt injection | Block user, review logs | 13-playbooks |
| Rate limit abuse | Block IP/tenant | 13-playbooks |
| Redis compromise | Rotate keys, restart | 13-playbooks |
| DDoS | Немедленно эскалация | 13-playbooks |

---

## 10. Security Terms (09-security/glossary.md)

| Термин | Сипаттамасы |
|--------|-------------|
| **SSRF** | Server-Side Request Forgery — сервердің ішкі ресурстарына шабуыл |
| **Prompt Injection** | LLM-ге зиянды нұсқаулар енгізу |
| **Tenant Isolation** | Әрбір клиенттің деректерін бөлек сақтау |
| **Rate Limiting** | Request санын шектеу |
| **DAN** | Do Anything Now — LLM jailbreak әдісі |

---

_Author: BekzatAI EOS_

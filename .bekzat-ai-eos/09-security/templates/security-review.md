# Security Review: WhatsApp Webhook Server

> **Reviewer:** BekzatAI Engineering
> **Күні:** 2026-06-10
> **Нұсқа:** 1.1

---

## Scope

Express 5 webhook сервері (POST /webhook/whatsapp), Redis кэш, NocoDB, OpenRouter (LLM), DLE API, WhatsPro API.

## Threat Model

### STRIDE

| Threat | Description | Severity | Mitigation |
|--------|-------------|----------|------------|
| **Spoofing** | Бөтен tenant-ның токенімен кіру | High | Chain auth (4 әдіс), tenant secret |
| **Tampering** | Webhook body өзгерту (MITM) | Medium | HTTPS (өрістен тыс), body.validation |
| **Repudiation** | Кім хабарлама жібергенін анықтау | Low | Логтарда tenant_id + phone сақталады |
| **Information Disclosure** | Бір tenant екіншісінің мәзірін көру | High | Redis prefix изоляция, NocoDB row-level |
| **Denial of Service** | Spam, rate limit | High | Rate limiter (15 req/min), spam mute (15 мин) |
| **Elevation of Privilege** | Tenant-тан admin-ге өту | Critical | Admin токені бөлек, super-admin role |

### Data Flow Review

```
Қауіпті: Клиент → WhatsApp → WhatsPro → Express (HTTPS) → LLM
  — 4-layer hallucination defense (LLM жалған ақпарат таратпау үшін)
  — SSRF қорғанысы (LLM басқа серверлерге request жасай алмайды)

Қорғалған: Express → Redis (localhost, пароль)
  — Redis Unix socket немесе пароль
  — Redis container-ге тек app container ғана қол жеткізе алады
```

## Findings

### Critical

- **SSRF (DNS rebinding):** Егер LLM (OpenRouter) кері шақыру жасаса, .env ALLOWED_DOMAINS тізімі тек NocoDB, DLE, WhatsPro, OpenRouter. Барлық басқа домендер блокталады.
  → **Recommendation:** DNS-деңгейінде блоктау (iptables/output filter).

### High

- **Tenant secret ағуы:** Егер tenant secret логқа жазылса, басқа tenant оны көре алады.
  → **Recommendation:** Логта token/secret-ті [FILTERED] деп ауыстыру.
- **Redis парольсіз:** Қазіргі Docker Compose-та Redis парольсіз.
  → **Recommendation:** `redis.conf`-ке `requirepass` қосу.

### Medium

- **NocoDB API ключі .env-те:** Қауіпті емес, бірақ егер .env ағып кетсе, NocoDB деректеріне қол жеткізуге болады.
  → **Recommendation:** .env файлын Docker volume ретінде сырттан беру.
- **WhatsPro API ключі логқа жазылуы мүмкін:** Webhook body-да token бар.
  → **Recommendation:** body.token-ді логта filter-леу.

### Low

- **Helmet middleware жоқ:** Express-те security headers жоқ.
  → **Recommendation:** `helmet` пакетін қосу.

## Secrets Check

- [ x ] .env файлында парольдер (OPENROUTER_API_KEY, NOCODB_API_KEY, т.б.)
- [ x ] API ключтер кодта емес (тек .env-те)
- [ ] Redis пароль қойылған (TODO: redis.conf-ке requirepass қосу)

## LLM Security

- [ x ] Prompt injection защитасы (4-layer defense)
- [ x ] Hallucination defense (instructions → pre-LLM → validator → facts)
- [ x ] Rate limiting (15 req/min)
- [ x ] Content filtering (menyu-only, link ban, competitor ban)
- [ x ] Token usage мониторингі

## Conclusion

**Conditional Approval.** Екі high-severity табуды түзету керек: (1) Redis паролі, (2) логтарда token фильтрациясы. Осы екі түзетуден кейін қайта тексеру қажет емес.

---

_Author: BekzatAI EOS_

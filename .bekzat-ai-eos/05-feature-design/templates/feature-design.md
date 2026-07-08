# Feature Design: Multi-Tenant Изоляция (v2)

> **Status:** Draft
> **Priority:** High
> **Author:** BekzatAI Engineering
> **Reviewers:** TBD
> **Created:** 2026-06-20
> **Updated:** 2026-06-22

---

## 1. Executive Summary

Openbot-fastfood бірнеше ресторанға (tenant) бір серверде қызмет көрсетеді. Қазіргі уақытта tenant изоляциясы Redis prefix (`{tenant}:*`) және NocoDB row-level арқылы жүзеге асады. Бірақ бұл жеткіліксіз: бір tenant-тың деректері екіншісіне ағып кетуі мүмкін (мысалы, rate limit counter-лерде, LLM контекстінде). Бұл feature multi-tenant изоляцияны күшейтеді: әр tenant өзінің деректерін ғана көреді, басқа tenant-тың деректеріне қол жеткізе алмайды.

## 2. User Stories

- Как [ресторан администраторы], мен [басқа ресторанның мәзірін көрмеуім керек], [деректер қауіпсіздігі] үшін.
- Как [tenant A], мен [tenant B-ның rate limit-іне әсер етпеуім керек], [спам қорғанысы] үшін.
- Как [система администраторы], мен [әр tenant-ты жеке мониторингтеуім керек], [проблеманы жылдам анықтау] үшін.

## 3. Requirements

### Functional

- [FR-1]: Әр tenant өзінің Redis prefix-інде ғана жұмыс істейді
- [FR-2]: Tenant A tenant B-ның rate limit-іне әсер етпейді
- [FR-3]: LLM контексті tenant-level изоляцияланған
- [FR-4]: Әр tenant өзінің API токенімен кіреді
- [FR-5]: Admin dashboard-та tenant арасында ауысу мүмкіндігі

### Non-Functional

- [NFR-1]: Performance: tenant изоляциясы latency-ге әсер етпеуі керек (latency < 100мс қосымша)
- [NFR-2]: Security: tenant A tenant B-ның деректеріне SSRF/Redis арқылы қол жеткізе алмауы керек
- [NFR-3]: Scalability: 100+ tenant-қа дейін жұмыс істеуі керек

## 4. Technical Design

### Архитектура

```
Әр tenant өзінің деректерін келесі схемамен сақтайды:

Redis:
  {tenant}:config        → конфигурация
  {tenant}:shpor         → мәзір кэші
  ratelimit:{tenant}:*   → rate limit counter
  spam:{tenant}:*        → spam mute
  context:{tenant}:*     → LLM контекст

NocoDB:
  config table → { instance, api_token, webhook_secret, ... }
  shpor table → { instance, name, price, ... } (filtered by instance)

LLM:
  buildFactsPrompt.ts → {tenant} фактын жүктейді
  instructions.ts → барлық tenant-қа ортақ
```

### Data Flow

```
Request → Auth Middleware 
  → tenant_id анықтау (token → instance mapping)
  → Redis prefix: {tenant_id}:
  → NocoDB query: WHERE instance = tenant_id
  → LLM facts: тек tenant деректері
```

### API Changes

- **Жаңа middleware:** `tenantResolver.middleware.ts` — request-тен tenant_id анықтайды және req.tenant орнатады
- **Өзгерген:** Барлық Redis/NocoDB шақырулары req.tenant пайдаланады

### Database/Redis Changes

- Жаңа Redis кілттері жоқ (бар prefix жеткілікті)
- NocoDB: config таблицасына `is_active` өрісі қосылады

### LLM Prompt Changes

- buildFactsPrompt.ts: `{tenant}` динамикалық айнымалысы тек сол tenant-тың мәзірін жүктейді

## 5. Alternatives Considered

### Alternative A: 1 tenant = 1 сервер

**Сипаттамасы:** Әр tenant үшін жеке Express инстанция.
**Неге қабылданбады:** Ресурстар тиімсіз, 100 tenant = 100 сервер. Қымбат және күрделі.

### Alternative B: Redis DB per tenant

**Сипаттамасы:** Әр tenant үшін жеке Redis DB (SELECT).
**Неге қабылданбады:** Redis DB 16 ғана, 100+ tenant үшін жеткіліксіз. Cluster-де жұмыс істемейді.

## 6. Rollout Plan

1. Feature flag `MULTI_TENANT_V2`
2. Бета-тестілеу (3 ресторан)
3. Барлық ресторанға rollout
4. Ескі prefix-терді тазалау (1 ай)

## 7. Monitoring & Metrics

- **Success metric:** 0 tenant data leak инцидент
- **Dashboard:** Redis key count by prefix
- **Alert:** Егер бір tenant екіншісінің prefix-іне жазуға тырысса

## 8. Edge Cases

- **Жаңа tenant қосу:** Онбординг кезінде префикс автоматты түрде жасалады
- **Tenant жою:** 30 күн grace period, сосын Redis key-лерін тазалау
- **Token компрометация:** Жаңа token генерация + ескі token-ді blocklist

## 9. Risks & Mitigations

| Тәуекел | Ықтималдық | Әсер | Mitigation |
|---------|-----------|------|------------|
| Redis prefix collision | Low | Critical | UUID не tenant_id пайдалану (instance емес) |
| Token leak | Medium | High | Rate limiting + blocklist |
| Кодта hardcoded prefix | Medium | Medium | Code review + tests |

## 10. Open Questions

- [ ] Tenant ID ретінде instance атауын пайдалануға бола ма? (Қазір солай)
- [ ] Admin dashboard-та tenant ауысу үшін арнайы super-admin токен керек пе?
- [ ] NocoDB-де 10000+ record болғанда, instance filter жеткілікті ме?

---

_Author: BekzatAI EOS_

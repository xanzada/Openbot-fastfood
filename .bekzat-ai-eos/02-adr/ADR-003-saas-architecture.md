# ADR-003: SaaS Platform Architecture

> **Статус:** Proposed
> **Күні:** 2026-07-08
> **Автор:** Chief Architect

---

## Контекст

Openbot-fastfood жеке боттан коммерциялық SaaS платформаға айналуда. Бұл үшін архитектуралық өзгерістер қажет:
1. Multi-tenant изоляция (әр ресторан өз дерегін өзі сақтайды)
2. Billing және usage metering
3. Plugin жүйесі (үшінші тарап разработчиктері үшін)
4. Feature flags (қауіпсіз rollout)
5. AI Skills Marketplace

---

## Шешім

Платформаны 5 тәуелсіз қабатқа бөлу:

```
┌─────────────────────────────────────────────────────────┐
│                    Presentation Layer                      │
│  Admin Dashboard  |  Tenant Portal  |  Public API       │
├─────────────────────────────────────────────────────────┤
│                    Business Layer                          │
│  Billing  |  Plugin Manager  |  Feature Flags  |  AI    │
├─────────────────────────────────────────────────────────┤
│                    Integration Layer                       │
│  NocoDB  |  Redis  |  WhatsApp  |  DLE  |  n8n          │
├─────────────────────────────────────────────────────────┤
│                    Tenant Isolation Layer                  │
│  Auth  |  Rate Limit  |  Key Prefix  |  Data Filter      │
├─────────────────────────────────────────────────────────┤
│                    Infrastructure Layer                    │
│  Docker  |  Redis Cluster  |  NocoDB  |  Monitoring      │
└─────────────────────────────────────────────────────────┘
```

---

## Детальды архитектура

### 1. Tenant Isolation Layer

Әрбір tenant (ресторан) үшін:

- **Redis key prefix:** `{instance}:`
- **NocoDB row filter:** `WHERE tenant_id = '{instance}'`
- **Rate limit:** `ratelimit:{instance}:{phone}` — жеке лимит
- **Config:** `{instance}:config` — жеке конфигурация
- **Billing:** `billing:usage:{instance}:{month}` — жеке есеп
- **Secret:** өз webhook secret

### 2. Business Layer

Әрбір бизнес-модуль тәуелсіз:

- **Billing Service:** Plan management, usage tracking, invoice generation
- **Plugin Manager:** Plugin lifecycle, sandbox, hooks
- **Feature Flags:** Global + tenant overrides, phased rollout
- **AI Service:** 4-layer hallucination defense, prompt management

### 3. Integration Layer

Сыртқы сервистердің барлығы tenant-aware:

```typescript
// Redis
getConfig(instance)  → `{instance}:config`
setShpor(instance)   → `{instance}:shpor`

// NocoDB
getConfig(instance)  → `?where=(instance,eq,{instance})`
listShpor(instance)  → `?where=(instance,eq,{instance})`
```

### 4. Data Ownership

```
Tenant A: Redis keys (prestige:*) | NocoDB rows (instance=prestige)
Tenant B: Redis keys (mangilik:*) | NocoDB rows (instance=mangilik)
Tenant C: Redis keys (besh:*)     | NocoDB rows (instance=besh)
```

Хостинг 3 түрлі:
- **Shared:** Жалпы Redis/NocoDB (Starter, Business)
- **Dedicated:** Жеке Redis/NocoDB (Enterprise)
- **On-premise:** Өз серверінде (Enterprise Custom)

---

## Альтернативалар

### A1: Monolith (status quo)
- **Pros:** Қарапайым, ештеңе өзгерту керек емес
- **Cons:** Tenant изоляция жоқ, billing жоқ, plugin жоқ, масштабталмайды
- **Decision:** REJECTED

### A2: Microservices
- **Pros:** Толық изоляция, әрбір сервис өз Redis/NocoDB
- **Cons:** DevOps күрделі, latency артады, development баяу
- **Decision:** REJECTED (2-3 жылдық жоспар)

### A3: Modular monolith (✅)
- **Pros:** Қарапайымдылық, жылдамдық, tenant изоляция

ең оңай, plugin системасына жол ашады
- **Cons:** Бір процесс — бір жерде проблема болса бәріне әсер етеді
- **Decision:** ACCEPTED (2026)

---

## Тәуекелдер

| Тәуекел | Ықтималдылық | Әсер | Mitigation |
|---------|-------------|------|------------|
| Tenant дерегі араласып кетуі | Low | Critical | Prefix + row-level filter + CI validation |
| Plugin sandbox бұзылуы | Medium | High | Resource quota, timeout, permission check |
| Billing метрикасының дұрыс есептелмеуі | Medium | Medium | Double-write (Redis + NocoDB), audit log |
| Feature flag көптігі | Medium | Low | Cleanup policy (2 week after GA) |

---

## Байланысты

- **ADR-002:** VoltAgent tool-based architecture
- **ADR-001:** 4-layer hallucination defense
- **21-engineering-constitution:** 10 hard rules
- **26-billing:** Billing system
- **27-plugin-system:** Plugin system
- **28-feature-flags:** Feature flags

---

_Author: BekzatAI EOS_

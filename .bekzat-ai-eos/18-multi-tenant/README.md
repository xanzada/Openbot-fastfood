# 18. Multi-Tenant

> **Нұсқа:** 2.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Multi-Tenant модель

BekzatAI SaaS платформасы — Multi-Tenant арқылы бір код базасында жүздеген ресторандарды қолдайды.

### Tenant деңгейлері

| Деңгей | Изоляция | Мысал |
|--------|----------|-------|
| **Shared** | Redis prefix + NocoDB row filter | Starter, Business |
| **Dedicated** | Жеке Redis DB + NocoDB project | Enterprise |
| **On-premise** | Клиенттің өз сервері | Enterprise Custom |

---

## 2. Tenant деректері

### 2.1 Әрбір tenant үшін сақталады

| Дерек | Storage | Key/Filter |
|-------|---------|------------|
| Config | Redis + NocoDB | `{instance}:config` |
| Shpor (FAQ) | Redis + NocoDB | `{instance}:shpor` |
| Rate limit | Redis | `ratelimit:{instance}:{phone}` |
| Spam status | Redis | `spam:{instance}:{phone}` |
| Magic links | Redis | `magiclink:{instance}:{phone}` |
| Mute status | Redis | `operator_mute:{instance}:{phone}` |
| Billing usage | Redis | `billing:usage:{instance}:{month}` |
| Feature flags | Redis | `flag:override:{instance}:{name}` |
| Plugin config | Redis | `{instance}:plugins:{plugin_name}` |
| Shift notes | Redis | `{instance}:shift_notes` |

### 2.2 Tenant идентификаторлары (instance field)

Жүйе келесі өрістерді бірдей қабылдайды:
- `instance`
- `instanceId`
- `restaurant_id`

Барлығы бір tenant-ты анықтайды.

---

## 3. Tenant изоляция механизмдері

### 3.1 Redis изоляция

```typescript
// prefix арқылы изоляция
const configKey = `${instance}:config`;
const shporKey = `${instance}:shpor`;

// Tenant A: "prestige:config" ≠ Tenant B: "mangilik:config"
// Бір Redis DB (shared) — prefix арқылы
// Enterprise: жеке Redis DB номері
```

### 3.2 NocoDB изоляция

```typescript
// Row-level filter
const rows = await nocodb.list('config', {
  where: `(instance,eq,${instance})`,
});

// Ешқандай tenant басқа tenant-тың дерегін көре алмайды
```

### 3.3 Rate limit изоляция

```typescript
// Әрбір tenant үшін жеке rate limit
const limitKey = `ratelimit:${instance}:${phone}`;
// Starter: 15 req/min
// Business: 60 req/min
// Enterprise: 300 req/min
```

### 3.4 Auth chain изоляция

```typescript
// 1. Глобалды webhook secret (OPENBOT_WEBHOOK_SECRET)
// 2. CRM secret (CRM_SECRET_TOKEN)
// 3. Tenant-level secret (assertTenantSecret — NocoDB config)
```

---

## 4. Tenant lifecycle

```
Request → Identify Tenant → Load Config → Process → Response
```

### 4.1 Tenant identification

```typescript
// 1. Body-дан instance анықтау
const instance = body.instance
  || body.instanceId
  || body.restaurant_id;

if (!instance) {
  return { ok: false, error: 'instance required' };
}

// 2. Tenant config жүктеу (Redis cache → NocoDB)
const config = await redis.get(`${instance}:config`)
  ?? await nocodb.getConfig(instance);
```

### 4.2 Tenant isolation validation

```typescript
// CI тест: tenant деректері араласпауы керек
test('tenant isolation', async () => {
  const a = await getConfig('tenant-a');
  const b = await getConfig('tenant-b');

  expect(a).not.toEqual(b);
  expect(a.instance).toBe('tenant-a');
  expect(b.instance).toBe('tenant-b');
});
```

---

## 5. Plan-based isolation

### 5.1 Rate limits per plan

| Plan | Requests/min | Requests/month | Skills | Support |
|------|-------------|---------------|-------|---------|
| Starter | 15 | 1,000 | 3 base | Email |
| Business | 60 | 10,000 | All | Email + Slack |
| Enterprise | 300 | Unlimited | All + Custom | 24/7 Priority |

### 5.2 Feature availability per plan

```typescript
const planFeatures = {
  starter: {
    skills: ['searchMenu', 'getPaymentDetails', 'updateCrmLead'],
    maxRestaurants: 1,
    llmModel: 'gemini-2.5-flash',
    plugins: false,
  },
  business: {
    skills: 'all',
    maxRestaurants: 5,
    llmModel: 'gpt-4o-mini + gemini',
    plugins: true,
  },
  enterprise: {
    skills: 'all + custom',
    maxRestaurants: -1, // unlimited
    llmModel: 'any',
    plugins: true,
    dedicatedInfra: true,
  },
};
```

---

## 6. Billing integration

- **Әрбір tenant:** жеке billing (26-billing)
- **Plan upgrade/downgrade:** дереу қолданылады
- **Suspended tenant:** LLM шақырылмайды, тек "бот тоқтатылды" жауабы
- **Cancelled tenant:** 90 күн сақталады, сосан жойылады

---

## 7. Feature flags per tenant

- **Global flags:** Барлық tenant-қа әсер етеді
- **Tenant override:** Жеке tenant үшін қосу/өшіру
- **Plan default:** Планға байланысты мәні
- **Kill switch:** Проблема болса emergency тоқтату

---

## 8. Plugin изоляция

- **Әрбір tenant** өз plugin-дерін таңдайды
- **Plugin sandbox:** Басқа tenant-тың дерегіне қатынай алмайды
- **Plugin limits:** CPU, memory, timeout (5s skill, 2s hook)
- **Config:** Tenant-level config per plugin

---

## 9. Tenant management API

```typescript
// Admin only
GET    /api/admin/tenants                    — List tenants
GET    /api/admin/tenants/:instance          — Tenant details
POST   /api/admin/tenants                    — Create tenant
PUT    /api/admin/tenants/:instance          — Tenant config
DELETE /api/admin/tenants/:instance          — Soft delete
POST   /api/admin/tenants/:instance/suspend  — Suspend
POST   /api/admin/tenants/:instance/restore  — Restore

// Tenant health
GET    /api/admin/tenants/:instance/health   — Usage stats
GET    /api/admin/tenants/:instance/logs     — Error logs
```

---

## 10. Масштабтау

| Tenant саны | Redis | NocoDB | Стратегия |
|-------------|-------|--------|-----------|
| 1-100 | 1 instance | 1 project | Shared (prefix/row filter) |
| 100-500 | Redis Cluster | Read replicas | Shared + caching |
| 500-2000 | Redis Cluster (16 DB) | Sharding | Dedicated DB per shard |
| 2000+ | Regional sharding | Regional NocoDB | Geo-distribution |

---

_Author: BekzatAI EOS_

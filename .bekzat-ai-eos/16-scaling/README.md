# 16. Scaling

> **Нұсқа:** 2.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Миссия

BekzatAI SaaS платформасын 1 рестораннан 10,000+ ресторанға дейін масштабтау. Бірде-бір архитектуралық шешім болашақта масштабталуды шектемеуі керек.

---

## 2. Multi-Tenant scaling модель

| Tenant саны | Архитектура | Redis | NocoDB | LLM | Айлық шығын |
|-------------|------------|-------|--------|-----|-------------|
| **1-100** | Single server | 1 instance | 1 project | Shared API ключ | ~$50-100 |
| **100-500** | Cluster (3 nodes) | Cluster (6 shards) | Read replicas | Модельдер пулы | ~$300-500 |
| **500-2,000** | Regional sharding | Cluster (16 shards) | Sharding (4 projects) | Multi-model + queue | ~$1,000-2,000 |
| **2,000+** | Geo-distributed | Regional clusters | Regional | Load balancing | ~$5,000+ |

---

## 3. Фазалар

### Phase 1: 1-100 ресторан (ағымдағы)

```
Architecture:
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Server  │ ──→ │  Redis   │ ──→ │  NocoDB  │
│ (single) │     │ (single) │     │ (single) │
└──────────┘     └──────────┘     └──────────┘
```

**Capacity:**
- CPU: 1 vCPU орта есеппен 20-30 tenant
- RAM: 2GB Redis → 100 tenant x 500 keys
- LLM: 15 req/min/tenant → 100 tenant = 1500 req/min

**Тәуекелдер:**
- Single point of failure (сервер құласа, бәрі құлайды)
- NocoDB rate limit (100 req/min)
- Redis memory (өсуі мүмкін)

**Митигация:**
- PM2 cluster mode (4 workers)
- NocoDB cache (1 min TTL)
- Redis eviction policy (allkeys-lru)

### Phase 2: 100-500 ресторан

```
Architecture:
┌────────────┐     ┌────────────────┐     ┌──────────────┐
│  LB (nginx)│ ──→ │  Server x3     │ ──→ │  Redis       │
│            │     │  (PM2 cluster) │     │  Cluster     │
└────────────┘     └────────────────┘     │  (6 shards)  │
                                          └──────────────┘
                          ──→  NocoDB (read replicas)
```

**Capacity:**
- 3 server x 4 workers = 12 concurrent
- Redis 6 shards → жоғары throughput
- Read replicas → NocoDB rate limit 6x

**Өзгерістер:**
- nginx load balancer
- Session affinity (instance hash)
- Redis Cluster (key prefix → shard mapping)
- NocoDB read replicas
- LLM request queue (RabbitMQ/Redis Streams)

### Phase 3: 500-2,000 ресторан

```
Architecture:
┌──────────┐     ┌────────────────┐     ┌──────────────────┐
│  Region  │     │  Shard 1       │     │  Redis Cluster   │
│  KZ-NUR  │     │  (tenants      │     │  (8 shards)      │
│  │       │ ──→ │   1-500)       │     │                  │
│  │       │     │  Server x5     │     │  NocoDB Project 1│
│  │       │     └────────────────┘     └──────────────────┘
│  │       │     ┌────────────────┐     ┌──────────────────┐
│  │       │     │  Shard 2       │     │  Redis Cluster   │
│  │       │ ──→ │  (tenants      │     │  (8 shards)      │
│  │       │     │   501-1000)    │     │                  │
│  │       │     │  Server x5     │     │  NocoDB Project 2│
│  │       │     └────────────────┘     └──────────────────┘
│  │       │     ┌────────────────┐     ┌──────────────────┐
│  │       │     │  Shard 3       │     │  Redis Cluster   │
│  │       │ ──→ │  (tenants      │     │  (8 shards)      │
│  │       │     │   1001-2000)   │     │                  │
│  │       │     │  Server x5     │     │  NocoDB Project 3│
│  │       │     └────────────────┘     └──────────────────┘
```

**Өзгерістер:**
- Regional sharding (Қазақстан: Нұр-Сұлтан, Алматы)
- Tenant → shard mapping (consistent hashing)
- Жеке Redis Cluster + NocoDB Project per shard
- LLM request queue with priority (paid > free)

### Phase 4: 2,000+ ресторан

```
Architecture:
┌────────────────┐     ┌────────────────────┐
│  Global LB     │     │  Region KZ         │
│  (DNS routing) │ ──→ │  NUR: shard 1-5    │
│                │     │  ALM: shard 6-10   │
│                │     │  Redis Regional    │
│                │     │  NocoDB Regional   │
│                │     └────────────────────┘
│                │     ┌────────────────────┐
│                │ ──→ │  Region RU         │
│                │     │  MSK: shard 11-15  │
│                │     │  Redis Regional    │
│                │     │  NocoDB Regional   │
│                │     └────────────────────┘
```

**Өзгерістер:**
- Geo-distribution (Қазақстан, Ресей, ТМД)
- Global DNS routing (latency-based)
- Regional Redis + NocoDB
- Data replication (async, cross-region)

---

## 4. Performance targets

| Metric | 1-100 | 100-500 | 500-2000 | 2000+ |
|--------|-------|---------|----------|-------|
| **p50 latency** | < 500ms | < 800ms | < 1s | < 1.5s |
| **p95 latency** | < 2s | < 3s | < 4s | < 5s |
| **p99 latency** | < 5s | < 6s | < 8s | < 10s |
| **Throughput** | 50 req/s | 200 req/s | 800 req/s | 2000 req/s |
| **Availability** | 99.5% | 99.7% | 99.9% | 99.95% |
| **LLM timeout** | 30s | 30s | 25s | 20s |

---

## 5. Негізгі bottleneckтер

| Bottleneck | Phase | Шешім | Cost |
|-----------|-------|-------|------|
| **LLM rate limit** (OpenRouter) | 1+ | Request queue, модельдер пулы | Low |
| **Redis memory** (key count) | 1 | Eviction policy (allkeys-lru) | Free |
| **Redis CPU** (single thread) | 2+ | Redis Cluster | Medium |
| **NocoDB rate limit** (100 req/min) | 1+ | Redis cache (1 min TTL) | Free |
| **NocoDB queries** (read load) | 2+ | Read replicas | Medium |
| **Single process** (CPU) | 1+ | PM2 cluster mode (4 workers) | Free |
| **Server capacity** (RAM, CPU) | 2+ | Horizontal scaling | Medium |
| **LLM cost** ($ tokens) | 1+ | Модель таңдау, caching | Variable |
| **Network** (WhatsApp API) | 3+ | Regional WhatsApp gateways | High |

---

## 6. Cost projection

### LLM costs

| Модель | 1K tokens бағасы | 100 tenant/ай | 1000 tenant/ай |
|--------|-----------------|---------------|----------------|
| gemini-2.5-flash | $0.00015 | ~$45 | ~$450 |
| gpt-4o-mini | $0.002 | ~$600 | ~$6,000 |
| claude-3-haiku | $0.0025 | ~$750 | ~$7,500 |

### Infrastructure

| Компонент | 100 tenant | 500 tenant | 2000 tenant |
|-----------|-----------|-----------|-------------|
| Server | $50 (1 x $50) | $250 (5 x $50) | $1,000 (20 x $50) |
| Redis | $30 (1 x $30) | $150 (5 x $30) | $600 (20 x $30) |
| NocoDB | $20 (1 x $20) | $60 (3 x $20) | $200 (10 x $20) |
| WhatsApp | $0.005/msg | $150 | $600 |
| **Total** | **~$150** | **~$1,000** | **~$5,000** |

### Revenue per tenant

| Plan | Price | 100 tenant | 500 tenant | 2000 tenant |
|------|-------|-----------|-----------|-------------|
| Starter ($49) | $49 | $4,900 | $24,500 | $98,000 |
| Business ($149) | $149 | $14,900 | $74,500 | $298,000 |
| Enterprise ($499) | $499 | $49,900 | $249,500 | $998,000 |
| **Revenue (70% Starter)** | | **~$7,000** | **~$35,000** | **~$140,000** |
| **Profit** | | **~$6,850** | **~$34,000** | **~$135,000** |

---

## 7. Scaling playbook

### Егер latency p95 > 3s:

1. Тексер: Redis cache hit ratio (кемінде 80%)
2. Тексер: LLM response time (OpenRouter dashboard)
3. Тексер: NocoDB response time
4. Шешім: Cache қосу / LLM модель ауыстыру / Scaling

### Егер error rate > 1%:

1. Тексер: Rate limiting (429 errors)
2. Тексер: LLM timeout (30s)
3. Тексер: NocoDB rate limit (100 req/min)
4. Шешім: Queue / Server көбейту / Cache

### Егер Redis memory > 80%:

1. Eviction policy тексер (allkeys-lru)
2. TTL оңтайландыру
3. Redis Cluster-ге көшу (Phase 2)

### Егер CPU > 80% (все workers):

1. PM2 workers көбейту (max 4 per CPU core)
2. Жаңа server қосу → load balancer
3. CDN / cache strat

---

_Author: BekzatAI EOS_

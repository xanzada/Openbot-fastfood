# Scaling Plan: Single Server → Multi-Node Cluster

> **Нұсқа:** 1.0
> **Current capacity:** 10 ресторан, 1 сервер, ~25 req/s
> **Target capacity:** 100 ресторан, 3+ сервер, ~250 req/s

---

## Current State

- **Express server:** 1 инстанция (port 4100), single-process
- **Redis:** 1 инстанция (standalone)
- **NocoDB:** Сыртқы сервис (rate limit: 100 req/min)
- **OpenRouter:** Сыртқы API (rate limit: 20 req/min free, 100+ paid)
- **Деплой:** Docker Compose, VPS (1 CPU, 2GB RAM)

**Боттлнектер:**
1. LLM rate limit — 20 req/min (free tier), 100 req/min (paid)
2. NocoDB rate limit — 100 req/min (кепілдік жоқ)
3. Single-process — 1 CPU ғана пайдаланады
4. Redis — single point of failure

## Target State

- **Express server:** 3+ инстанция (load balancer артында)
- **Redis:** Cluster (3 node) немесе Sentinel
- **NocoDB:** Тек cache арқылы (Redis), NocoDB-ге тікелей request жоқ
- **OpenRouter:** 2+ API ключ (round-robin)
- **Деплой:** Kubernetes немесе Docker Swarm

## Gap Analysis

| Аспект | Current | Target | Gap |
|--------|---------|--------|-----|
| Requests/sec | 25 | 250 | 10x |
| Redis keys | 500 | 5000 | 10x |
| Memory | 256MB | 2GB | 8x |
| LLM req/min | 20 | 200 | 10x |
| Server count | 1 | 3 | 3x |
| Availability | 99% | 99.9% | +0.9% |

## Implementation Plan

### Phase 1 (1 month) — Quick wins

- [ ] **PM2 cluster mode:** 4 процесс (CPU санына байланысты)
- [ ] **Redis connection pooling:** Redis reconnect + pool
- [ ] **NocoDB cache TTL 300s** (120s → 300s, cache miss 8% → 3%)
- [ ] **LLM model fallback:** Gemini fails → GPT-4o Mini автоматты

**Estimated cost:** $0 (тек конфигурация)

### Phase 2 (3 months) — Horizontal scaling

- [ ] **Load balancer:** nginx (round-robin, 3 backend)
- [ ] **Sticky sessions:** жоқ (stateless design)
- [ ] **Redis Sentinel:** 1 master + 2 replica
- [ ] **LLM key rotation:** 2 API ключ, round-robin

**Estimated cost:** $30/ай (2 VPS)

### Phase 3 (6 months) — Full production

- [ ] **Kubernetes:** 3-5 pod, auto-scaling (CPU > 70%)
- [ ] **Redis Cluster:** 3 master + 3 replica
- [ ] **Message queue:** RabbitMQ (асинхронды хабарлама өңдеу)
- [ ] **Multi-region:** Екі географиялық аймақ

**Estimated cost:** $150/ай

## Cost

| Компонент | Қазір | Phase 1 | Phase 2 | Phase 3 |
|-----------|-------|---------|---------|---------|
| VPS | $10/ай | $10/ай | $40/ай | $100/ай |
| Redis | $0 (бірге) | $0 | $10/ай | $30/ай |
| OpenRouter | $5/ай | $5/ай | $20/ай | $50/ай |
| LLM tokens | $5/ай | $5/ай | $15/ай | $30/ай |
| NocoDB | $0 (self-hosted) | $0 | $0 | $10/ай |
| **Total** | **$20/ай** | **$20/ай** | **$85/ай** | **$220/ай** |

## Risks

- **NocoDB rate limit:** Егер NocoDB 100+ req/min көтермесе, өзге caching стратегиясы қажет
- **OpenRouter price:** LLM token көлемі 10x өссе, цена $50/ай → $500/ай
- **Redis cluster complexity:** Cluster режимі операциялық күрделілікті арттырады

---

_Author: BekzatAI EOS_

# Agent: Performance

> **Рөлі:** Performance engineer — жүйенің жылдамдығы мен тиімділігін қамтамасыз етеді.

## Expertise

- LLM latency optimization (model selection, caching)
- Redis performance (key design, pipeline, cluster)
- NocoDB query optimization (caching, read replicas)
- Node.js profiling (event loop, memory)
- Load testing (k6, autocannon)

## Targets

| Metric | Target | Critical |
|--------|--------|----------|
| p50 latency | < 1s | > 2s |
| p95 latency | < 3s | > 5s |
| p99 latency | < 5s | > 8s |
| Throughput | 50 req/s | < 20 req/s |
| Availability | 99.5% | < 99% |
| LLM timeout | < 30s | > 30s |

## Bottlenecks

| Bottleneck | Detection | Fix |
|-----------|-----------|-----|
| LLM slow | OpenRouter dashboard | Switch model / queue |
| Redis memory | `INFO memory` | Eviction / Cluster |
| Redis CPU | `INFO cpu` | Cluster (more shards) |
| NocoDB rate | 429 errors | Cache (1 min TTL) |
| NocoDB slow | Response > 500ms | Read replicas |
| Event loop | `process.hrtime()` | Split CPU work |

## Optimization Rules

1. **Cache NocoDB** — TTL 1 min, Redis
2. **Batch Redis** — pipeline where possible
3. **Lazy load shpor** — tylko when needed
4. **Evict history** — `LTRIM ... 0 99`
5. **Timeout all** — LLM 30s, API 10s, Redis 2s
6. **Model selection** — gemini-2.5-flash > gpt-4o-mini (10x cheaper)
7. **Keep-alive** — WhatsApp connection pool

## Profiling

```bash
# Event loop lag
node -e "setInterval(() => console.log(process.hrtime.bigint()), 100)"

# Heap
node --trace-gc src/server.ts

# PM2
pm2 monit
pm2 show bekzat-api
```

## Cost Optimization

| Strategy | Savings | Effort |
|----------|---------|--------|
| gemini over gpt4 | 10x | Low |
| Cache NocoDB | 5x queries | Low |
| LTRIM history | 50% memory | Low |
| Batch Redis | 3x throughput | Medium |
| Request merging | 20% LLM | Medium |

---

_See: `10-performance/templates/performance-review.md`, `16-scaling/README.md`_

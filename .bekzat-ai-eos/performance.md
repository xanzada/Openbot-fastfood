# Performance

> **Targets:** p50 < 1s, p95 < 3s, p99 < 5s. **Availability:** 99.5%+.

## Bottlenecks

| Bottleneck | Impact | Solution | Priority |
|-----------|--------|----------|----------|
| LLM latency | 500ms-3s | Model selection (gemini > gpt4), timeout 30s | High |
| Redis throughput | 50K ops/s limit | Cluster (100+ tenants) | High |
| NocoDB rate limit | 100 req/min | Redis cache (1 min TTL) | High |
| Single process | CPU bound | PM2 cluster (4 workers) | Medium |
| WhatsApp API | Network latency | Keep-alive connection | Medium |
| History size | Memory | LTRIM to 100 messages | Medium |

## Latency Budget (webhook)

```
Auth chain:          < 5ms
Guard:               < 2ms
Preload context:     < 50ms  (Redis get + NocoDB cache)
LLM (VoltAgent):     < 5000ms (includes tools)
Final validator:     < 2ms
WhatsApp send:       < 200ms
History save:        < 5ms
                         ─────────
Total (p95):         < 3000ms
```

## Redis Performance

```bash
# Monitor slow commands
redis-cli SLOWLOG GET 10

# Memory
redis-cli INFO memory | grep used_memory_human

# Hit rate
redis-cli INFO stats | grep keyspace_hits
```

## Optimization Rules

1. **Cache everything** that comes from NocoDB (TTL: 1 min)
2. **Batch** Redis calls where possible (pipeline)
3. **Lazy load** shpor — only when context needs it
4. **Evict** old history (`LTRIM history:{instance}:{phone} 0 99`)
5. **Timeout** all external calls (LLM: 30s, API: 10s, Redis: 2s)
6. **Monitor** p50/p95/p99 — alert if exceeding targets

## Monitoring

| Metric | Warning | Critical | Action |
|--------|---------|----------|--------|
| LLM p95 latency | > 3s | > 5s | Switch model / queue |
| Redis memory | > 80% | > 90% | Eviction / Cluster |
| Error rate | > 1% | > 5% | Rollback / Fix |
| 429 rate | > 5% | > 10% | Rate limit tuning |
| NocoDB response | > 500ms | > 1s | Cache / Read replica |

## Cost Optimization

| Strategy | Savings | Effort |
|----------|---------|--------|
| gemini-2.5-flash over gpt-4o-mini | 10x | Low (swap model) |
| Cache NocoDB responses | 5x fewer queries | Low |
| LTRIM chat history | 50% memory | Low |
| Batch Redis pipeline | 3x throughput | Medium |
| Request merging (same phone, same second) | 20% LLM calls | Medium |

---

_See: `10-performance/templates/performance-review.md`, `15-monitoring/templates/grafana-dashboard.md`_

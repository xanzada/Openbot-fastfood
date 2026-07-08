# Dashboard Definition: Openbot-fastfood Overview

> **Дашборд атауы:** Openbot-fastfood Production
> **Platform:** Grafana (Prometheus datasource)
> **Нұсқа:** 1.1

---

## Панельдер

### Row 1: System Overview

1. **Uptime** (stat panel)
   - Query: `up{job="openbot-fastfood"}`
   - Threshold: < 1 → critical

2. **Request Rate** (time series)
   - Query: `rate(http_requests_total[5m])`
   - Unit: req/s
   - Alert: > 50 req/s for 5 min

3. **Active Tenants** (stat panel)
   - Query: `count(redis_keys{prefix="tenant:*"})`
   - Current active tenants

4. **HTTP Error Rate** (time series)
   - Query: `rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) * 100`
   - Alert: > 5% for 5 min

### Row 2: LLM Performance

5. **LLM Response Time (p50, p95, p99)** (time series)
   - Query: 
     - p50: `histogram_quantile(0.50, rate(llm_latency_seconds_bucket[5m]))`
     - p95: `histogram_quantile(0.95, rate(llm_latency_seconds_bucket[5m]))`
     - p99: `histogram_quantile(0.99, rate(llm_latency_seconds_bucket[5m]))`
   - Alert: p95 > 10s → warning, p95 > 20s → critical

6. **Token Usage Per Model** (stacked bar)
   - Query: `sum by(model) (llm_token_count_total)`
   - Breakdown: gemini-2.5-flash, gemini-2.5-flash-lite, gpt-4o-mini
   - Unit: tokens

7. **LLM Error Rate by Model** (time series)
   - Query: `rate(llm_errors_total[5m])`
   - Alert: error rate > 5% for any model

8. **Model Distribution** (pie chart)
   - Query: `count(llm_request_total) by (model)`
   - Show: percentage of requests per model

### Row 3: Redis

9. **Redis Memory Usage** (time series)
   - Query: `redis_memory_used_bytes / redis_memory_max_bytes * 100`
   - Alert: > 80% → warning, > 95% → critical

10. **Redis Hit Rate** (time series)
    - Query: `rate(redis_keyspace_hits_total[5m]) / (rate(redis_keyspace_hits_total[5m]) + rate(redis_keyspace_misses_total[5m])) * 100`
    - Alert: < 80% → warning

11. **Redis Key Count by Prefix** (table)
    - Query: `count by (prefix) (redis_key_count)`
    - Group: config, shpor, ratelimit, spam, context

### Row 4: Business Metrics

12. **Messages Per Tenant** (bar chart)
    - Query: `sum by (tenant) (messages_total)`
    - Period: last 24h

13. **Menu Views** (stat panel)
    - Query: `increase(menu_views_total[24h])`
    - Unit: views/day

14. **Link Clicks** (stat panel)
    - Query: `increase(link_clicks_total[24h])`
    - Unit: clicks/day

15. **Daily Active Users** (time series)
    - Query: `count(unique_phones_last_24h)`
    - Unit: users

## Alert Configuration

| Alert | Query | Threshold | Duration | Channel |
|-------|-------|-----------|----------|---------|
| Server Down | `up{job="app"}` | < 1 | 30s | Slack + SMS |
| High Error Rate | `rate(http_5xx[5m]) > 0.05` | > 5% | 5 min | Slack |
| LLM High Latency | `llm_p95_latency` | > 10s | 5 min | Slack |
| LLM High Error Rate | `llm_error_rate` | > 5% | 5 min | Slack |
| Redis Memory | `redis_memory_usage` | > 80% | 2 min | Slack |
| Redis Low Hit Rate | `redis_hit_rate` | < 80% | 5 min | Slack |
| Spam Attack | `rate_limit_exceeded` | > 10/min | 1 min | Log |

## Labels

- `env`: production, staging
- `tenant`: restaurant_1, restaurant_2, ...
- `model`: gemini-2.5-flash, gpt-4o-mini
- `status`: 2xx, 4xx, 5xx

---

_Author: BekzatAI EOS_

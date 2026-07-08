# Agent: DevOps

> **Рөлі:** DevOps / SRE — инфрақұрылым, CI/CD, мониторинг, инциденттер.

## Expertise

- Docker контейнеризация (Node.js 20+)
- PM2 cluster mode (4 workers)
- Redis Cluster (6+ shards)
- NocoDB (single → read replicas → sharding)
- GitHub Actions (CI/CD pipeline)
- Grafana + Prometheus мониторинг

## Infrastructure

```
Development:  docker compose (Node + Redis)
Staging:      single server (Node + Redis)
Production:   LB + cluster (3+ nodes, Redis Cluster)
Enterprise:   dedicated infra per tenant
```

## CI/CD Pipeline

### PR
```
Push → Build → Lint → Typecheck → Test → Result ✅/❌
```

### Merge to main
```
Build → Test → Docker build → Push registry →
Deploy staging → Smoke test → Manual approval → Production
```

### Tag (v*.*.*)
```
Tag → Build → Test → Docker build → Push semver → Deploy
```

## Monitoring

| Service | Tool | Alert |
|---------|------|-------|
| Server | Grafana | CPU > 80%, memory > 80% |
| Redis | Redis Insight / Grafana | Memory > 80%, hit rate < 80% |
| NocoDB | Health endpoint | Response > 1s |
| LLM | OpenRouter dashboard | Latency > 5s, error > 5% |
| WhatsApp | Custom health | Send failure > 1% |

## Deployment

```bash
# Production deploy
docker build -t bekzat-api:latest .
docker push registry/bekzat-api:latest
ssh server "docker pull registry/bekzat-api:latest && docker compose up -d"

# Health check
curl https://api.bekzatai.kz/health
curl https://api.bekzatai.kz/health/detailed
```

## Incident Response

```
1. Detect (alert / user report)
2. Acknowledge (#incidents Slack)
3. Triage (P0/P1/P2)
4. Playbook → Mitigate
5. Fix → Deploy
6. Monitor (30 min)
7. Postmortem
```

## Scaling Phases

| Phase | Tenants | Stack |
|-------|---------|-------|
| 1 | 1-100 | Single server + Redis |
| 2 | 100-500 | LB + 3 nodes + Cluster |
| 3 | 500-2000 | Sharding + regional |
| 4 | 2000+ | Geo-distributed |

---

_See: `08-deployment/templates/docker-setup.md`, `15-monitoring/templates/grafana-dashboard.md`_

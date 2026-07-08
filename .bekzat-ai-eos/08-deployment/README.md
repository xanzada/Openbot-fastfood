# 08. Deployment

> Мақсаты: Жүйені орнату, конфигурациялау және CI/CD құжаттары.

## Мазмұны

- [Docker Setup](./templates/docker-setup.md)
- [CI/CD Pipeline](./templates/cicd-pipeline.md)
- [Runbook](./templates/deployment-runbook.md)

## Орнату

### Quick Start

```bash
git clone https://github.com/example/openbot-fastfood.git
cp .env.example .env
npm install
npm run build
npm start
```

### Docker

```bash
docker compose up -d
```

## Environment Variables

| Айнымалы | Сипаттамасы | Default |
|----------|-------------|---------|
| `PORT` | Сервер порты | 4100 |
| `REDIS_URL` | Redis қосылымы | redis://localhost:6379 |
| `NOCODB_API_KEY` | NocoDB API кілті | - |
| `OPENROUTER_API_KEY` | OpenRouter API кілті | - |

## CI/CD Pipeline

- **Build:** GitHub Actions → Docker image → ghcr.io
- **Deploy:** SSH → docker compose pull && up
- **Health check:** /health endpoint
- **Rollback:** docker compose up -d [previous tag]

---

_Author: BekzatAI EOS_

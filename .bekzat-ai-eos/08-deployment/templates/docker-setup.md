# Docker Setup: Openbot-fastfood Express Server

> **Нұсқа:** 1.1
> **Base image:** node:20-alpine

---

## Build

```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build

FROM node:20-alpine AS production
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY .env .env

# Security: read-only root
RUN chown -R node:node /app
USER node

EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:4100/health || exit 1

CMD ["node", "dist/server.js"]
```

## Docker Compose

```yaml
version: '3.8'
services:
  app:
    build: .
    container_name: openbot-fastfood
    ports:
      - "4100:4100"
    env_file: .env
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - app-network

  redis:
    image: redis:7-alpine
    container_name: openbot-redis
    ports:
      - "6379:6379"
    volumes:
      - redis-data:/data
      - ./redis.conf:/usr/local/etc/redis/redis.conf
    command: redis-server /usr/local/etc/redis/redis.conf
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 5
    restart: unless-stopped
    networks:
      - app-network

volumes:
  redis-data:

networks:
  app-network:
    driver: bridge
```

## Environment

| Айнымалы | Міндетті | Default | Сипаттамасы |
|----------|----------|---------|-------------|
| `PORT` | Жоқ | 4100 | Сервер порты |
| `NODE_ENV` | Жоқ | development | production/development |
| `REDIS_URL` | Иә | redis://redis:6379 | Redis қосылымы |
| `OPENROUTER_API_KEY` | Иә | — | OpenRouter API ключі |
| `NOCODB_API_KEY` | Иә | — | NocoDB API ключі |
| `NOCODB_URL` | Иә | — | NocoDB сервер URL |
| `NOCODB_CONFIG_TABLE` | Иә | — | Config таблица ID |
| `NOCODB_SHPOR_TABLE` | Иә | — | Shpor (menu) таблица ID |
| `WHATS_PRO_API_URL` | Иә | — | WhatsPro API URL |
| `ALLOWED_DOMAINS` | Иә | — | SSRF DNS allowed list |
| `OPENBOT_WEBHOOK_SECRET` | Иә | — | Global webhook secret |
| `OPENBOT_RESPONSE_CHUNK_MAX` | Жоқ | 650 | Хабарлама chunk мөлшері |
| `OPENROUTER_AGENT_MODEL` | Жоқ | google/gemini-2.5-flash | LLM модель |
| `TAVILY_API_KEY` | Жоқ | — | Tavily search API ключі |
| `WHATS_PRO_API_TOKEN` | Иә | — | WhatsPro API токені |
| `DEVELOPER_PHONE` | Жоқ | — | Developer телефон нөмірі |
| `CRM_SECRET_TOKEN` | Жоқ | — | CRM secret token (backup) |

## Health Check

```
GET /health → 200 { ok: true, uptime: 3600 }
GET /health/detailed → { ok, redis, nocodb, uptime }
```

## Volumes

- `redis-data:/data` — Redis persistence (AOF + RDB)
- `./.env:/app/.env` — .env файлын сырттан беру (қауіпсіздік)

## Networks

- `app-network` — app + redis

---

_Author: BekzatAI EOS_

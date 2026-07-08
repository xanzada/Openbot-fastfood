# Node.js

> **Runtime:** Node.js 20+ (LTS), ES modules.

## Entry

```bash
# Production
node dist/server.js

# Development
node --watch --import tsx src/server.ts
```

## Dependencies (core)

| Package | Purpose |
|---------|---------|
| `express` | HTTP server |
| `socket.io` | WebSocket (printer signals) |
| `ioredis` | Redis client |
| `@voltagent/core` | AI agent framework |
| `tsx` | TypeScript executor (dev) |

## Process

```bash
# PM2 cluster mode (production)
pm2 start dist/server.js -i 4 --name "bekzat-api"

# Health check
curl http://localhost:3000/health
curl http://localhost:3000/health/detailed
```

## Environment

| Variable | Required | Default |
|----------|----------|---------|
| `NODE_ENV` | No | `development` |
| `PORT` | No | `3000` |
| `REDIS_HOST` | Yes | — |
| `REDIS_PORT` | No | `6379` |
| `REDIS_PASSWORD` | Production | — |

## Error Handling

```typescript
// Express: always catch async
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

// Never crash on unhandled rejection
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
```

## Debug

```bash
# Logs
pm2 logs bekzat-api

# Inspect
node --inspect src/server.ts
chrome://inspect
```

---

_See: `08-deployment/templates/docker-setup.md`_

# Redis

> **Client:** ioredis. **Use:** config cache, rate limiting, session, shpor, magic links.

## Connection

```typescript
// src/services/redis.service.ts
import Redis from 'ioredis';

export const redis = new Redis({
  host: process.env.REDIS_HOST,
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});
```

## Key Namespace

All keys prefixed with `{instance}:` for tenant isolation.

| Key Pattern | Type | TTL | Purpose |
|-------------|------|-----|---------|
| `{instance}:config` | Hash | ∞ | Restaurant config |
| `{instance}:shpor` | Hash | ∞ | FAQ knowledge base |
| `ratelimit:{instance}:{phone}` | String | 60s | Rate limit counter |
| `spam:{instance}:{phone}` | String | configurable | Spam mute |
| `magiclink:{instance}:{phone}` | String | configurable | Menu magic link |
| `operator_mute:{instance}:{phone}` | String | 300s | Operator message mute |
| `history:{instance}:{phone}` | List | configurable | Chat history |
| `billing:usage:{instance}:{month}` | String | 35d | Usage metering |
| `flag:override:{instance}:{name}` | String | ∞ | Feature flag override |

## Commands

```typescript
// String
await redis.set(key, value, 'EX', ttl);
await redis.get(key);
await redis.incr(key);

// Hash
await redis.hset(key, field, value);
await redis.hget(key, field);
await redis.hgetall(key);

// List
await redis.rpush(key, value);
await redis.lrange(key, 0, -1);
await redis.ltrim(key, 0, 99);

// TTL & Expire
await redis.expire(key, seconds);
await redis.ttl(key);

// Pub/Sub
await redis.publish(channel, message);
```

## Production Config

```bash
# Redis must have password
# Maxmemory + eviction
maxmemory 2gb
maxmemory-policy allkeys-lru

# Persistence (optional, cache only)
save 900 1
save 300 10
```

## Timeouts

All Redis calls: **2s timeout**. Never block the event loop.

```typescript
const result = await Promise.race([
  redis.get(key),
  new Promise((_, rej) => setTimeout(() => rej(new Error('Redis timeout')), 2000)),
]);
```

## Scaling

| Tenants | Config |
|---------|--------|
| 1-100 | Single instance |
| 100-500 | Cluster (6 shards) |
| 500+ | Regional cluster |

---

_See: `18-multi-tenant/README.md`, `10-performance/templates/performance-review.md`_

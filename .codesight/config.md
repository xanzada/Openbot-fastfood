# Config

## Environment Variables

- `ANALYTICS_CRON_EXPR` (has default) — .env.example
- `ANALYTICS_TIMEZONE` (has default) — .env.example
- `BOT_IGNORE_SAVED_CONTACTS` (has default) — .env.example
- `CHATWOOT_ADAPTER_URL` **required** — src\services\diagnostics.service.ts
- `CRM_SECRET_TOKEN` **required** — .env.example
- `DEVELOPER_PHONE` **required** — .env.example
- `ENABLE_AUTO_FAILOVER` (has default) — .env
- `ENABLE_KEY_ROTATION` (has default) — .env
- `ENABLE_MODEL_ROTATION` (has default) — .env
- `GEMINI_API_KEY_1` **required** — .env
- `GEMINI_API_KEY_2` **required** — .env
- `GEMINI_API_KEY_3` **required** — .env
- `GEMINI_API_KEY_4` **required** — .env
- `GEMINI_API_KEY_5` **required** — .env
- `GEMINI_API_KEY_6` **required** — .env
- `GEMINI_API_KEYS` **required** — src\agent\modelRouter.ts
- `GEMINI_MAX_RETRIES` (has default) — .env
- `GEMINI_MEDIA_MODEL` (has default) — .env
- `GEMINI_MODEL` (has default) — .env
- `GEMINI_ROTATION_ENABLED` (has default) — .env
- `LLM_FALLBACK_PROVIDER` (has default) — .env
- `LLM_PROVIDER` (has default) — .env
- `MAX_RETRY_PER_KEY` (has default) — .env
- `N8N_WEBHOOK_TIMEOUT_MS` (has default) — .env.example
- `N8N_WEBHOOK_TOKEN` **required** — .env.example
- `N8N_WEBHOOK_URL` **required** — .env.example
- `NOCODB_SHPOR_TABLE_ID` **required** — src\services\nocodb.service.ts
- `NOCODB_TABLE_ID` (has default) — .env.example
- `NOCODB_TOKEN` (has default) — .env.example
- `NOCODB_URL` (has default) — .env.example
- `OPENBOT_MAX_MEDIA_BYTES` (has default) — .env.example
- `OPENBOT_RESPONSE_CHUNK_MAX` (has default) — .env.example
- `OPENBOT_SPAM_LIMIT_PER_MINUTE` (has default) — .env.example
- `OPENBOT_SPAM_MUTE_SECONDS` (has default) — .env.example
- `OPENBOT_WEBHOOK_SECRET` **required** — .env.example
- `OPENROUTER_AGENT_MODEL` (has default) — .env.example
- `OPENROUTER_API_KEY` **required** — .env.example
- `OPENROUTER_FALLBACK_ENABLED` (has default) — .env
- `OPENROUTER_MEDIA_MODEL` (has default) — .env.example
- `OPENROUTER_MODEL` (has default) — .env
- `OPERATOR_MUTE_MAX_SECONDS` (has default) — .env.example
- `PORT` (has default) — .env.example
- `PRIVATE_CONTACT_KEYWORDS` (has default) — .env.example
- `REDIS_URL` (has default) — .env.example
- `SHPOR_CONTEXT_LIMIT` **required** — src\services\nocodb.service.ts
- `TAVILY_API_KEY` **required** — .env.example
- `WHATSPRO_API_TOKEN` **required** — .env.example
- `WHATSPRO_BASE_URL` **required** — .env.example
- `WHATSPRO_PASSWORD` (has default) — .env
- `WHATSPRO_PRESENCE_URL` **required** — .env.example
- `WHATSPRO_SEND_URL` **required** — .env.example
- `WHATSPRO_USER` (has default) — .env

## Config Files

- `.env.example`
- `Dockerfile`
- `docker-compose.yml`
- `tsconfig.json`

## Key Dependencies

- ai: ^6.0.208
- express: ^5.2.1
- redis: ^5.10.0
- socket.io: ^4.8.1
- zod: ^4.4.3

# Standards

> **Мақсаты:** Платформаның барлық стандарттары — кодтан бастап API-ға дейін.

---

## Coding Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [Coding Standards](../19-standards/01-coding-standards.md) | TypeScript strict mode, naming, imports, env, Redis, Express, LLM |
| [Review Checklist](../19-standards/review-checklist.md) | PR review standards |

### Key Standards

| Аспект | Стандарт |
|--------|----------|
| **Тіл** | TypeScript (strict mode) |
| **Формат** | Biome |
| **Импорт** | ES modules (`.js` extension) |
| **Атау** | camelCase (функциялар), PascalCase (класс/типтер), kebab-case (файлдар) |
| **Commit** | Conventional Commits (`feat:`, `fix:`, т.б.) |
| **PR size** | < 400 строк |

---

## API Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [API Endpoints](../03-api/templates/api-endpoint.md) | REST endpoint definitions |
| [Webhook Contract](../03-api/templates/webhook-contract.md) | Webhook format, auth chain |
| [Feature Design](../05-feature-design/templates/feature-design.md) | Feature specification |

### Key Standards

- All responses JSON
- Errors: `{ ok: false, error: "message" }`
- POST body `application/json`
- Auth: Bearer → x-api-key → body.token → tenant secret (chain)
- Status: 200 OK, 202 Accepted (async), 400/401/403/429/500
- Webhook: `POST /webhook/whatsapp` → 202 + async processing

---

## LLM Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [Prompt Documentation](../06-prompts/templates/prompt-documentation.md) | Prompt lifecycle, 4-layer defense |
| [Prompt Versioning](../06-prompts/README.md) | v1-v4, per-tenant rollout |

### Key Standards

| Аспект | Стандарт |
|--------|----------|
| **Температура** | 0.7 |
| **Max tokens** | 500 |
| **Max steps** | 6 |
| **Hallucination defense** | 4-layer (instructions → pre-LLM → validator → facts) |
| **Prompt** | Тек brand guidelines, business logic кодта |
| **Response** | Max 2 sentences |
| **Language** | Қазақ немесе орыс (таза) |
| **Timeout** | 30s |

---

## Security Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [SECURITY.md](../09-security/SECURITY.md) | Full threat model |
| [Security Review](../09-security/templates/security-review.md) | Review template |
| [Incident Response (Security)](../09-security/templates/incident-response.md) | Security incident |

### Key Standards

- .env: секреттер ешқашан кодта
- API ключтер: .env / сервер env ғана
- Redis: пароль міндетті (production)
- Rate limiting: 15 req/min (Starter), 60 (Business), 300 (Enterprise)
- SSRF: DNS allowed list
- Tenant isolation: Redis prefix + NocoDB row-level

---

## Multi-Tenant Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [Multi-Tenant](../18-multi-tenant/README.md) | Full isolation model |

### Key Standards

- Redis: `{instance}:` prefix барлық key-лерде
- NocoDB: `WHERE (instance,eq,{instance})` барлық query-де
- Rate limit: жеке per tenant
- Billing: жеке metering per tenant
- Feature flags: tenant override мүмкін
- Plugins: tenant-level lifecycle + isolation

---

## Billing Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [Billing System](../26-billing/README.md) | Plans, pricing, metering |

### Key Standards

| Plan | Price | Requests/min | Requests/month | Skills |
|------|-------|-------------|---------------|-------|
| **Starter** | $49/ай | 15 | 1,000 | 3 |
| **Business** | $149/ай | 60 | 10,000 | All |
| **Enterprise** | $499/ай | 300 | Unlimited | All + Custom |

---

## Deployment Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [Deployment Runbook](../08-deployment/templates/deployment-runbook.md) | Deploy procedure |
| [CI/CD](../08-deployment/templates/cicd-pipeline.md) | Pipeline definition |
| [Docker Setup](../08-deployment/templates/docker-setup.md) | Container standards |

### Key Standards

- Docker container (Node.js 20+)
- PM2 cluster mode (4 workers)
- Redis: пароль + TLS (production)
- NocoDB: read replicas (100+ tenants)
- Feature flags: phased rollout
- Rollback: documented + tested

---

## Integration Standards

| Құжат | Сипаттамасы |
|-------|-------------|
| [Integration Guide](../12-integrations/templates/integration-guide.md) | DLE, NocoDB, WhatsApp |
| [OpenRouter](../12-integrations/templates/openrouter-integration.md) | LLM provider |
| [Plugin System](../27-plugin-system/README.md) | Plugin SDK |

### Key Standards

- NocoDB: REST API, row-level security
- Redis: key prefix per tenant
- WhatsApp: HTTP API (WhatsPro)
- DLE: PHP bridge (api_bot.php)
- n8n: webhook-based workflow
- Plugins: sandbox, permission-based API access

---

## Glossary

| Құжат | Сипаттамасы |
|-------|-------------|
| [Glossary](../20-glossary/glossary.md) | All terms A-Z (42+ entries) |

---

_Author: BekzatAI EOS_

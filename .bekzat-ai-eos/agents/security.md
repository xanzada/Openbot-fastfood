# Agent: Security

> **Рөлі:** Security engineer — платформа қауіпсіздігі, threat model, аудит.

## Expertise

- Webhook auth chain (Bearer → x-api-key → body.token → tenant secret)
- SSRF protection (DNS allowed list)
- Rate limiting (15/60/300 req/min per tenant)
- Tenant isolation (Redis prefix + NocoDB row filter)
- Prompt injection defense (4-layer)
- Secrets management (.env, never in code)

## Threat Model

| Threat | Protection | Status |
|--------|-----------|--------|
| SSRF / DNS rebinding | DNS allowed list | ✅ |
| Prompt injection | 4-layer defense | ✅ |
| Spam / flood | Rate limiter (Redis) | ✅ |
| Tenant data leak | Prefix + row filter | ✅ |
| Unauthorized access | Auth chain | ✅ |
| DDoS | Rate limit + IP block | 🔄 |

## Security Checklist

### Pre-Deploy
- [ ] Auth chain configured (secrets in .env)
- [ ] Rate limiting enabled per plan
- [ ] Spam protection enabled
- [ ] SSRF DNS allowed list set
- [ ] Redis password set (production)
- [ ] Tenant isolation verified
- [ ] CORS restricted origins
- [ ] 4-layer defense active
- [ ] Logging: no PII logged

### Code Review
- [ ] Input validated
- [ ] No hardcoded keys/tokens
- [ ] Tenant isolation maintained
- [ ] SSRF risks checked
- [ ] Rate limiting considered

## Incident Response

| Severity | Response | Notify |
|----------|----------|--------|
| P0 (data leak) | Immediate block, rotate keys | #incidents Slack |
| P1 (SSRF) | Block IP, review logs | #incidents Slack |
| P2 (rate abuse) | Block tenant | Tech Lead |

## Environment

```bash
# Required in production
REDIS_PASSWORD=strong_password
OPENBOT_WEBHOOK_SECRET=secret
CRM_SECRET_TOKEN=secret
OPENROUTER_API_KEY=sk-...
WHATSAPP_ACCESS_TOKEN=...
NOCODB_API_KEY=...
```

---

_See: `09-security/SECURITY.md`, `09-security/templates/security-review.md`_

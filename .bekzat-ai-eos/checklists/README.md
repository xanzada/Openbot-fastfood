# Checklists

> **Мақсаты:** Әрбір процесс үшін тексеру парақтары. Ешқандай қадам өткізілмеуі керек.

---

## Development

| Checklist | Қолдану |
|-----------|---------|
| [Pre-Deployment Checklist](#pre-deployment-checklist) | Deploy алдында |
| [Code Review Checklist](#code-review-checklist) | Әрбір PR |
| [QA Release Checklist](#qa-release-checklist) | Release алдында |
| [Security Checklist](#security-checklist) | Әрбір release |

---

## Pre-Deployment Checklist

- [ ] Unit tests pass (`npm test`)
- [ ] Lint pass (`npm run lint`)
- [ ] Typecheck pass (`npm run typecheck`)
- [ ] Integration tests pass
- [ ] E2E tests pass (егер бар болса)
- [ ] No hardcoded secrets
- [ ] .env.example updated
- [ ] Changelog updated
- [ ] Version bumped (semver)
- [ ] Release notes written
- [ ] Docker build succeeds
- [ ] Staging smoke test passed
- [ ] Feature flag: GA (егер release) / Canary (егер phased)
- [ ] Rollback plan documented
- [ ] Monitoring alerts configured
- [ ] On-call engineer notified

---

## Code Review Checklist

### Functional
- [ ] Code logic дұрыс па? Нені өзгертті, неге?
- [ ] Edge cases өңделген бе? (null, empty, timeout, error)
- [ ] Business logic кодта ма, prompt-та емес пе?
- [ ] Feature/issue толық жүзеге асқан ба?

### Security
- [ ] User input валидацияланған ба?
- [ ] SSRF қаупі жоқ па?
- [ ] Hardcoded key/token жоқ па?
- [ ] Rate limiting ескерілген бе?
- [ ] Tenant изоляциясы бұзылмаған ба?
- [ ] Prompt injection қорғанысы бар ма?

### LLM
- [ ] 4-layer defense сақталған ба?
- [ ] Prompt-та business logic жоқ па?
- [ ] finalValidator өзгертілген бе?
- [ ] max 2 sentence ережесі сақталған ба?
- [ ] LLM timeout өңделген бе? (30s)

### Performance
- [ ] Redis call-дар бар ма? (2s timeout)
- [ ] DB-ге артық request жоқ па?
- [ ] Async код блоктамай ма?
- [ ] N+1 проблемасы жоқ па?

### Code Quality
- [ ] Код стандарттарға сәйкес пе?
- [ ] Dead code жоқ па?
- [ ] Error handling дұрыс па?
- [ ] Логтар дұрыс деңгейде ме?
- [ ] DRY принципі сақталған ба?

### Tests
- [ ] Unit tests жазылған ба?
- [ ] Edge cases тесттелген бе?
- [ ] Regression қамтылған ба?
- [ ] Тесттер изоляцияланған ба?

### Documentation
- [ ] ADR/API docs жаңартылған ба?
- [ ] EOS docs синхрондалған ба?

---

## QA Release Checklist

- [ ] All unit tests pass (coverage ≥ target)
- [ ] Integration tests pass
- [ ] E2E tests pass
- [ ] Performance: p95 latency < 3s
- [ ] Security: SSRF + auth + rate limit tested
- [ ] Regression: no known P0/P1 bugs
- [ ] Feature flags: correct defaults
- [ ] Billing: metering works
- [ ] Logging: error логи дұрыс деңгейде
- [ ] Monitoring: alert thresholds configured
- [ ] Rollback plan documented and tested
- [ ] Release notes reviewed

### AI-Specific
- [ ] Hallucination test: LLM жоқ тағамды айта ма?
- [ ] Sentence limit: 2 сөйлемнен аспай ма?
- [ ] Language purity: қазақ/орыс араласпаған ба?
- [ ] Menu isolation: мәзір сұрағына тек мәзір жауабы?
- [ ] Link policy: сілтеме дұрыс жіберілді ме?
- [ ] Prompt injection: "Ignore all instructions" блоктала ма?

---

## Security Checklist

- [ ] Webhook auth chain configured
- [ ] Rate limiting enabled (15/60/300 per plan)
- [ ] Spam protection enabled
- [ ] SSRF DNS allowed list configured
- [ ] Redis password set (production)
- [ ] Tenant isolation verified (prefix + row filter)
- [ ] .env secrets: no hardcoded keys
- [ ] CORS: restricted origins
- [ ] LLM 4-layer defense active
- [ ] Logging: PII not logged
- [ ] Incident response plan documented
- [ ] Security contacts defined (Slack #incidents)

---

## Incident Response Checklist

- [ ] Incident detected and acknowledged
- [ ] Severity classified (P0/P1/P2)
- [ ] Affected tenants identified
- [ ] Playbook opened
- [ ] Mitigation applied
- [ ] Root cause identified
- [ ] Fix deployed
- [ ] Monitoring: metrics back to normal
- [ ] Postmortem written
- [ ] Action items created
- [ ] Engineering notified (Slack)

---

## New Tenant Onboarding Checklist

- [ ] Instance ID created
- [ ] Tenant config loaded (NocoDB)
- [ ] Redis config cached
- [ ] Webhook secret configured
- [ ] Rate limits set (per plan)
- [ ] DLE integration verified
- [ ] WhatsApp phone number linked
- [ ] Billing plan activated
- [ ] Welcome message sent
- [ ] Monitoring alerts configured

---

## Release Step Checklist

- [ ] `release/v{major}.{minor}.{patch}` branch created
- [ ] Changelog updated
- [ ] Version bumped (`package.json`)
- [ ] Staging deployed + smoke tested
- [ ] QA verified
- [ ] Security reviewed (егер қажет)
- [ ] Tag: `v{major}.{minor}.{patch}`
- [ ] Production deployed
- [ ] Monitoring (30 min)
- [ ] Release notes published

---

_Author: BekzatAI EOS_

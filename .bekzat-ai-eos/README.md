# BekzatAI Engineering Operating System (EOS)

> Нұсқа: 1.0.0
> Соңғы жаңарту: 2026-07-08
> Статус: Active

---

## Миссия

BekzatAI Engineering Operating System — бұл коммерциялық SaaS платформасын дамытуға арналған толық инженерлік жүйе. Барлық техникалық процесс, стандарт, шаблон және құжаттама бір жерде жинақталған.

## Құрылым

```
.bekzat-ai-eos/
│
├── engineering/         # Архитектура, API, workflow, deployment, quality, incidents, scaling
├── rules/               # Constitution, LLM rules, security rules, coding rules, tenant rules
├── checklists/          # Pre-deploy, code review, QA release, security, incident, onboarding
├── standards/           # Coding, API, LLM, security, multi-tenant, billing, deployment, integration
│
├── 01-architecture/
├── 02-adr/
├── 03-api/
├── 04-bug-reports/
├── 05-feature-design/
├── 06-prompts/
├── 07-release-notes/
├── 08-deployment/
├── 09-security/
├── 10-performance/
├── 11-testing/
├── 12-integrations/
├── 13-playbooks/
├── 14-incidents/
├── 15-monitoring/
├── 16-scaling/
├── 17-restaurant-onboarding/
├── 18-multi-tenant/
├── 19-standards/
├── 20-glossary/
├── 21-engineering-constitution/
├── 22-chief-architect/
├── 23-workflow/
├── 24-qa/
├── 25-review/
├── 26-billing/
├── 27-plugin-system/
└── 28-feature-flags/
```

## Принциптер

1. **Documentation as Code** — Барлық құжаттама код ретінде сақталады
2. **Templates First** — Кез келген процесс шаблоннан басталады
3. **ADR Driven** — Әрбір маңызды шешім ADR арқылы құжатталады
4. **Postmortem Culture** — Әрбір incident-тен сабақ алынады
5. **Security by Design** — Қауіпсіздік архитектураның бөлігі, қосымша емес
6. **Code over Prompt** — Business logic тек кодта
7. **Multi-Tenant First** — Әрбір шешім 1000 tenant-қа жұмыс істеуі керек
8. **Billing Aware** — Әрбір request-тің $ бағасы бар
9. **Plugins Over Monolith** — Әрбір жаңа модуль plugin ретінде
10. **Feature Flags Everywhere** — Ешқандай feature тікелей production-ға шықпайды
11. **QA as Gate** — Сапа жеткізілімнің шарты
12. **Review ALL PRs** — Ешқандай exceptions

## Рөлдер

| Рөл | Жауапкершілік |
|-----|---------------|
| **Chief Architect** | ADR, architecture doc, scaling планы, tech debt, SaaS vision |
| **Tech Lead** | Feature design, deployment, код ревью, feature flags |
| **SRE** | Monitoring, playbooks, incident response, scaling |
| **Security Engineer** | Security review, threat model, tenant isolation |
| **QA Engineer** | Testing report, test plan, regression |
| **Product Engineer** | Feature request, release notes, billing |
| **AI Engineer** | Prompt spec, prompt review, 4-layer defense, prompt versioning |
| **Integration Engineer** | Integration guide, webhook contract |
| **Plugin Developer** | Plugin SDK, marketplace skills |

## Навигация (4 organizing directories + agents + quick refs)

### Agents (AI role definitions)

| Agent | File | Expertise |
|-------|------|-----------|
| **Architect** | [`agents/architect.md`](agents/architect.md) | System architecture, ADR, scaling, tech debt |
| **Backend** | [`agents/backend.md`](agents/backend.md) | Express, Redis, NocoDB, WhatsApp API |
| **Reviewer** | [`agents/reviewer.md`](agents/reviewer.md) | Code review, PR standards, merge rules |
| **QA** | [`agents/qa.md`](agents/qa.md) | Testing, regression, AI-specific tests |
| **Security** | [`agents/security.md`](agents/security.md) | Threat model, auth chain, SSRF, isolation |
| **DevOps** | [`agents/devops.md`](agents/devops.md) | CI/CD, Docker, monitoring, deployment |
| **Performance** | [`agents/performance.md`](agents/performance.md) | Latency, optimization, cost, profiling |
| **Debugger** | [`agents/debugger.md`](agents/debugger.md) | Error analysis, Redis/NocoDB/LLM debug |
| **AI** | [`agents/ai.md`](agents/ai.md) | VoltAgent, 4-layer defense, 7 tools |
| **Prompt** | [`agents/prompt.md`](agents/prompt.md) | Prompt design, v4 rules, injection testing |

### Quick Reference Files

| File | Covers |
|------|--------|
| [`typescript.md`](typescript.md) | TS config, patterns, conventions |
| [`nodejs.md`](nodejs.md) | Runtime, deps, process, env |
| [`redis.md`](redis.md) | Connection, keys, commands, scaling |
| [`api.md`](api.md) | Endpoints, auth, response format |
| [`security.md`](security.md) | Auth chain, rate limit, SSRF, isolation |
| [`prompt.md`](prompt.md) | 4-layer defense, v4 rules, versioning |
| [`testing.md`](testing.md) | Vitest, pyramid, AI-specific tests |
| [`review.md`](review.md) | PR process, checklist, standards |
| [`architecture.md`](architecture.md) | High-level, dependency graph, data flow |
| [`documentation.md`](documentation.md) | This EOS structure and rules |
| [`performance.md`](performance.md) | Bottlenecks, latency, optimization |

### Directories

| Directory | Content | Link |
|-----------|---------|------|
| **engineering/** | Архитектура, API, workflow, deployment, quality, incidents, scaling | [engineering/](engineering/README.md) |
| **rules/** | Constitution, LLM rules, security rules, coding rules, tenant rules | [rules/](rules/README.md) |
| **checklists/** | Pre-deploy, code review, QA release, security, incident, onboarding | [checklists/](checklists/README.md) |
| **standards/** | Coding, API, LLM, security, multi-tenant, billing, deployment, integration | [standards/](standards/README.md) |

## Процестер

- [Analyze → Plan → Approve → Implement → Test → Document](23-workflow/README.md)
- [Feature Development](05-feature-design/templates/feature-request.md)
- [Bug Triage](04-bug-reports/BUG-000-template.md)
- [Incident Response](13-playbooks/templates/playbook-incident.md)
- [Release Process](07-release-notes/templates/release-notes.md)
- [Deployment](08-deployment/templates/deployment-runbook.md)
- [CI/CD Pipeline](08-deployment/templates/cicd-pipeline.md)
- [Security Review](09-security/templates/security-review.md)
- [Code Review](25-review/README.md)
- [Billing & Subscription](26-billing/README.md)
- [Plugin System & Marketplace](27-plugin-system/README.md)
- [Feature Flags & Rollout](28-feature-flags/README.md)
- [SaaS Platform ADR](02-adr/ADR-003-saas-architecture.md)

## Жаңарту ережелері

1. Әрбір PR өзгерістерімен бірге EOS құжаттамасын да жаңартады
2. ADR ешқашан өшірілмейді, тек superseded деп белгіленеді
3. Incident әрқашан postmortem-мен аяқталады
4. Шаблондар өзгермеуі керек — тек толтырылады

---

_BekzatAI Engineering Operating System — Build systems, not chaos._

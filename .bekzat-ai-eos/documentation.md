# Documentation

> **Principle:** Documentation as Code. All docs live in `.bekzat-ai-eos/`.

## Structure

```
.bekzat-ai-eos/
├── README.md              ← Root (misison, structure, roles, processes)
│
├── engineering/           ← Architecture, API, workflow, deploy, quality, incidents
├── rules/                 ← Constitution, LLM, security, coding, tenant rules
├── checklists/            ← Pre-deploy, code review, QA, security, incident
├── standards/             ← Coding, API, LLM, security, multi-tenant, billing
│
├── *.md                   ← Quick refs (typescript, nodejs, redis, api, etc.)
│
├── 01-architecture/       ← System architecture docs
├── 02-adr/                ← Architecture Decision Records
├── 03-api/                ← API contracts
├── 04-bug-reports/        ← Bug reports
├── 05-feature-design/     ← Feature designs
├── 06-prompts/            ← Prompt engineering
├── 07-release-notes/      ← Release notes
├── 08-deployment/         ← Deployment
├── 09-security/           ← Security
├── 10-performance/        ← Performance
├── 11-testing/            ← Testing
├── 12-integrations/       ← Integrations
├── 13-playbooks/          ← Playbooks
├── 14-incidents/          ← Incidents
├── 15-monitoring/         ← Monitoring
├── 16-scaling/            ← Scaling
├── 17-restaurant-onboarding/ ← Onboarding
├── 18-multi-tenant/       ← Multi-tenant
├── 19-standards/          ← Standards
├── 20-glossary/           ← Glossary
├── 21-engineering-constitution/ ← Constitution
├── 22-chief-architect/    ← Chief Architect
├── 23-workflow/           ← Workflow
├── 24-qa/                 ← QA
├── 25-review/             ← Review
├── 26-billing/            ← Billing
├── 27-plugin-system/      ← Plugin system
└── 28-feature-flags/      ← Feature flags
```

## When to Update

| Event | Update |
|-------|--------|
| New feature | Feature design + ADR (егер керек) + EOS docs + Release notes |
| Bug fix | Bug report + EOS docs (егер API/architecture өзгерсе) |
| Architecture change | ADR + System architecture + Multi-tenant |
| API change | API endpoints + Webhook contract |
| Prompt change | Prompt docs + version bump |
| Security fix | Security docs + Incident report |
| New module | Template + EOS docs + Glossary |
| Release | Release notes + Changelog |

## Rules

1. **Every PR** updates EOS if relevant
2. **ADR** never deleted — only superseded
3. **Postmortem** required for every incident
4. **Templates** never modified — only filled
5. **Glossary** updated when new term introduced
6. **Quick refs** (`*.md` root files) kept in sync with detailed docs

## Quick Ref Files (root)

| File | Covers |
|------|--------|
| `typescript.md` | TS config, patterns, conventions |
| `nodejs.md` | Runtime, deps, process, env |
| `redis.md` | Connection, keys, commands, scaling |
| `api.md` | Endpoints, auth, response format |
| `security.md` | Auth chain, rate limit, SSRF, isolation |
| `prompt.md` | 4-layer defense, v4 rules, versioning |
| `testing.md` | Vitest, pyramid, AI-specific tests |
| `review.md` | PR process, checklist, standards |
| `architecture.md` | High-level, dependency graph, data flow |
| `documentation.md` | This file — structure, rules |
| `performance.md` | Bottlenecks, latency targets, optimization |

---

_See: `README.md` (root)_

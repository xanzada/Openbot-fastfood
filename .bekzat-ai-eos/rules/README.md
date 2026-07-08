# Rules

> **Мақсаты:** Платформаның барлық міндетті ережелері.

---

## Constitution

| Құжат | Сипаттамасы |
|-------|-------------|
| [Engineering Constitution](../21-engineering-constitution/README.md) | 8 sections, 10 hard rules, principles |

## 10 Hard Rules (Executive Summary)

1. **Prompt-та business logic жоқ** — тек brand guidelines
2. **Әрбір LLM жауабы кодпен валидацияланады** (finalValidator.ts)
3. **4-layer defense міндетті** — ешқандай exceptions
4. **Барлық сыртқы request-тер timeout-пен** (max 30s LLM, 10s API, 2s Redis)
5. **Барлық қателер логқа жазылады** + developer notify (егер critical)
6. **Feature flag арқылы rollout** — tenant бойынша бөлек
7. **ADR-сіз ешқандай маңызды шешім** қабылданбайды
8. **Postmortem-сіз ешқандай инцидент** жабылмайды
9. **Код ревью-сіз ешқандай PR** merged емес
10. **Документсіз ешқандай feature** released емес

## Prompt Rules

| Құжат | Сипаттамасы |
|-------|-------------|
| [Prompt Documentation](../06-prompts/templates/prompt-documentation.md) | Prompt lifecycle |
| [Prompt Versioning](../06-prompts/README.md) | v1-v4, per-tenant rollout |

## LLM Rules

- Температура: 0.7
- Max tokens: 500
- Max steps: 6
- Max 2 sentences (finalValidator)
- Тек қазақ немесе орыс тілі
- Сілтеме тек бір рет (magic link dedup)
- Wait-time тек runtime қосылғанда

## Security Rules

| Құжат | Сипаттамасы |
|-------|-------------|
| [Security Overview](../09-security/README.md) | Security principles |
| [SECURITY.md](../09-security/SECURITY.md) | Full threat model, SSRF, tenant isolation, prompt injection |
| [Security Review](../09-security/templates/security-review.md) | Security review template |
| [Incident Response (Security)](../09-security/templates/incident-response.md) | Security incident template |

## Coding Rules

| Құжат | Сипаттамасы |
|-------|-------------|
| [Coding Standards](../19-standards/01-coding-standards.md) | TypeScript strict, naming, imports |
| [Review Checklist](../19-standards/review-checklist.md) | Code review rules |

## Tenant Rules

| Құжат | Сипаттамасы |
|-------|-------------|
| [Multi-Tenant](../18-multi-tenant/README.md) | Isolation, lifecycle, plans |
| [Billing Rules](../26-billing/README.md) | Plans, limits, subscription state machine |
| [Feature Flag Rules](../28-feature-flags/README.md) | Phased rollout, A/B testing |

---

_Author: BekzatAI EOS_

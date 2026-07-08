# 09. Security

> Мақсаты: Қауіпсіздік саясаты, тексерулер және жауап беру жоспарлары.

## Мазмұны

- [SECURITY.md](./SECURITY.md) — Толық қауіпсіздік құжаттамасы (threat model, SSRF, tenant isolation, prompt injection, rate limiting, env vars)
- [Security Review Template](./templates/security-review.md)
- [Incident Response Template](./templates/incident-response.md)

## Қауіпсіздік принциптері

1. **Least Privilege:** Әрбір компонент тек қажетті рұқсаттарға ие
2. **Defense in Depth:** Көп қабатты қорғаныс (SSL, аутентификация, ратинг)
3. **Never Trust User Input:** Барлық кіріс деректер валидацияланады
4. **Secrets Management:** Парольдер/токендер .env-те, кодта ешқашан
5. **SSRF Protection:** DNS allowed list арқылы
6. **LLM Hallucination Defense:** 4-layer модель (instructions → pre-LLM → validator → facts)

## Known Threats

| Threat | Қорғаныс | Статус |
|--------|----------|--------|
| SSRF (DNS rebinding) | DNS allowed list in .env | Implemented |
| Prompt injection | Character escape, 4-layer defense | Implemented |
| Spam / flooding | Rate limiter (Redis) | Implemented |
| Tenant data leak | Multi-tenant isolation | Planned |
| SQL injection | Parameterized queries | Not applicable (NocoDB) |

---

_Author: BekzatAI EOS_

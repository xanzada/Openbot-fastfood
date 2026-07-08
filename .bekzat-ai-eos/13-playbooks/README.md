# 13. Playbooks

> Мақсаты: Инциденттерге, операцияларға және техникалық процестерге арналған қадамдық нұсқаулықтар.

## Playbook Index

| Атауы | Сипаттамасы | Trigger |
|-------|-------------|---------|
| [LLM Timeout](./templates/playbook-incident.md) | LLM 30s ішінде жауап бермегенде | Alert: llm_timeout |
| [Redis Outage](./templates/playbook-incident.md) | Redis қосылуы жоғалғанда | Alert: redis_down |
| [WhatsPro Webhook Failure](./templates/playbook-incident.md) | WhatsApp хабарлары келмегенде | Alert: webhook_stale |
| [Spam Attack](./templates/playbook-incident.md) | Бір нөмірден көп хабар келгенде | Rate limit exceeded |

---

_Author: BekzatAI EOS_

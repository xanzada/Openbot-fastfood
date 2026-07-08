# 06. Prompts

> **Нұсқа:** 2.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Prompt versioning

Әрбір prompt-тың нұсқасы tenant деңгейінде басқарылады.

### 1.1 Әрбір tenant үшін

```typescript
// Tenant config: prompt_version = "v4"
// Барлық LLM request-тер осы нұсқамен жіберіледі

// Redis: {instance}:prompt_version
// Default: v4 (жаңа tenant-тар үшін)
// Override: 28-feature-flags арқылы rollout
```

### 1.2 Version storage

```
src/agent/
├── instructions/          # Prompt нұсқалары
│   ├── v1.ts              # Бірінші нұсқа
│   ├── v2.ts              # Сөйлем шегі
│   ├── v3.ts              # Link policy
│   └── v4.ts              # 10 hard rules (current)
├── instructions.ts        # Selector: version → instructions
└── buildFactsPrompt.ts    # Facts prompt (tenant-aware)
```

### 1.3 Version selector

```typescript
// src/agent/instructions.ts
const INSTRUCTIONS = {
  v1: `Сен BekzatAI ботсың...`,
  v2: `Сен BekzatAI ботсың. Ең көбі 2 сөйлеммен жауап бер...`,
  v3: `Сен BekzatAI ботсың. 2 сөйлем. Сілтеме тек бір рет...`,
  v4: `Сен BekzatAI-дың AI ассистентісің...
1. ЕҢ КӨБІ 2 ҚЫСҚА СӨЙЛЕМ
2. ТЕК ҚАЗАҚ НЕМЕСЕ ОРЫС ТІЛІНДЕ
...`,
};

export function getInstructions(version: string = 'v4'): string {
  return INSTRUCTIONS[version] ?? INSTRUCTIONS.v4;
}
```

### 1.4 Prompt rollout

```
v1 → v2:  2 sentence limit (security)
v2 → v3:  Link policy (spam reduction)
v3 → v4:  10 hard rules + business logic removal

Rollout per tenant via feature flag:
  Phase 1: 5% (canary)
  Phase 2: 50%
  Phase 3: 100%
  Rollback: emergency flag
```

---

## 2. Ережелер

1. Әрбір промпттың нұсқасы (v1, v2, ...) сақталады
2. Әрбір өзгертудің себебі түсіндіріледі (ADR)
3. Prompt-тан business logic кодқа көшірілген сайын, сол факт "moved to code" деп белгіленеді
4. 4-layer defense принципі сақталады: instructions.ts → pre-LLM → finalValidator.ts → buildFactsPrompt.ts
5. Prompt өзгерген сайын ADR жазылады және prompt version bump
6. Ескі нұсқалар ешқашан өшірілмейді — тек archive

---

## 3. Prompt түрлері

| Prompt | Source | 4-layer | Versioned | Tenant-aware |
|--------|--------|---------|-----------|-------------|
| **System instructions** | `instructions.ts` | Layer 1 | ✅ v1-v4 | ✅ per tenant |
| **Pre-LLM short-circuit** | `preloadContext.ts` | Layer 2 | ✅ runtime reply | ✅ config-based |
| **Final validator** | `finalValidator.ts` | Layer 3 | ✅ code (not prompt) | ❌ global |
| **Facts prompt** | `buildFactsPrompt.ts` | Layer 4 | ❌ dynamic | ✅ per tenant |
| **User message** | LLM input | — | ❌ raw | ✅ per tenant |

---

## 4. Changelog

| Нұсқа | Күні | Өзгеріс | Себебі | ADR |
|-------|------|---------|--------|-----|
| v1 | 2026-01-15 | Бастапқы | | — |
| v2 | 2026-06-01 | 2 sentence limit | LLM hallucination | ADR-001 |
| v3 | 2026-06-10 | Link policy | Spam блоктау | ADR-001 |
| v4 | 2026-06-20 | 10 hard rules | Business logic code-ға көшу | ADR-001 |

---

## 5. Prompt review process

Әрбір prompt өзгерісі:

```
1. Analyze: неге өзгерту керек? (bug, feature, security)
2. Plan: жаңа prompt жобасы
3. Approve: Chief Architect (LLM-ге тікелей әсер етеді)
4. Implement: кодта жазу (instructions/v{n}.ts)
5. Test: hallucination, injection, jailbreak тесттері
6. Document: changelog, ADR, EOS
7. Rollout: feature flag → phased rollout
```

---

## 6. Tenant-specific prompts

Кейбір ресторандарға жеке prompt нұсқасы қажет болуы мүмкін:

```typescript
// Redis: {instance}:prompt_custom
// Егер custom prompt болса → tenant-тың өз versions
// Егер болмаса → tenant-тың prompt_version бойынша глобалды
```

---

_Author: BekzatAI EOS_

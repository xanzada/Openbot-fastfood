# 28. Feature Flags & Rollout

> **Нұсқа:** 1.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Миссия

Feature Flags — жаңа функционалды қауіпсіз rollout ету, A/B тестілеу, tenant деңгейінде конфигурациялау. Ешқандай feature тікелей production-ға шықпайды.

---

## 2. Flag Architecture

```
┌──────────────────────────────────────────────────────┐
│                  Feature Flag Service                   │
├──────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Flag         │  │ Targeting    │  │ Evaluation │ │
│  │ Registry     │  │ Engine       │  │ (boolean)  │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │ Override     │  │ Experiment   │  │ Analytics  │ │
│  │ (per tenant) │  │ (A/B test)   │  │ (exposure) │ │
│  └──────────────┘  └──────────────┘  └────────────┘ │
│  ┌────────────────────────────────────────────────┐  │
│  │  Admin API (REST) + Dashboard UI               │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 2.1 Flag evaluation flow

```
Code calls: isEnabled('new-validator')
  ↓
1. Check local cache (Redis)
2. Check tenant override:   {instance}:flags:new-validator
3. Check plan tier:         Starter → false, Business → true
4. Check experiment:        A/B group → true/false
5. Check global default:    true/false
  ↓
Return boolean
```

---

## 3. Flag Types

| Type | Сипаттамасы | Мысал |
|------|-------------|-------|
| **Release** | Жаңа функционалды rollout | `new-final-validator` |
| **Experiment** | A/B тест | `ab-test-menu-layout` |
| **Permission** | Белгілі планға ғана | `premium-skills` |
| **Kill switch** | Проблема болса тоқтату | `emergency-kill-llm` |
| **Ops** | Операциялық баптаулар | `maintenance-mode` |

### 3.1 Flag definition (в коде)

```typescript
// src/config/feature-flags.ts
export const featureFlags = {
  'new-validator': {
    description: 'Жаңа finalValidator v3',
    type: 'release',
    default: false,
    plan: ['business', 'enterprise'],
    owner: 'ai-team',
    createdAt: '2026-07-01',
  },
  'ab-test-menu-format': {
    description: 'A/B тест: мәзір форматы',
    type: 'experiment',
    default: false,
    targeting: {
      percentage: 50,
      criteria: { random: true },
    },
  },
  'premium-skills': {
    description: 'Premium AI Skills',
    type: 'permission',
    default: false,
    plan: ['enterprise'],
  },
  'maintenance-mode': {
    description: 'Техникалық жұмыс режимі',
    type: 'ops',
    default: false,
    override: 'admin-only',
  },
} as const;
```

---

## 4. Rollout стратегиясы

### 4.1 Phased rollout

```
Phase 1 → Phase 2 → Phase 3 → GA
   5%      20%       50%      100%
```

| Phase | % | Tenant selection | Duration | Validation |
|-------|---|-----------------|----------|------------|
| **Phase 1 (Canary)** | 5% | Ішкі тест tenant-тары | 1-2 days | Manual QA |
| **Phase 2 (Early)** | 20% | Starter план ғана | 3-5 days | Monitoring |
| **Phase 3 (Wide)** | 50% | Барлық план | 5-7 days | Metrics OK |
| **GA (General)** | 100% | Барлық tenant | Permanent | No rollback |

### 4.2 Rollback

```typescript
// Emergency rollback
async function emergencyRollback(flag: string): Promise<void> {
  await redis.set(`flag:global:${flag}`, 'false');
  await redis.publish('feature-flag:changed', { flag, value: false });

  // Notify
  await notifySlack(`🚨 Emergency rollback: ${flag}`);
  await createIncident(`Feature flag ${flag} rolled back`);
}
```

### 4.3 Rollout approval

| Phase | Approver |
|-------|----------|
| Phase 1 → 2 | Tech Lead |
| Phase 2 → 3 | Chief Architect |
| Phase 3 → GA | Chief Architect + QA sign-off |
| Rollback | Кез келген engineer (автоматты) |

---

## 5. Админ панелі (Feature Flag Dashboard)

### 5.1 Функционал

- Барлық flag тізімі (status, type, owner)
- Глобалды қосу/өшіру
- Tenant override (жеке tenant-қа қосу/өшіру)
- Plan-based default
- A/B experiment конфигурациясы
- Audit log (кім, қашан, нені өзгертті)

### 5.2 API

```typescript
// Admin API
GET    /api/admin/flags                    — List all flags
GET    /api/admin/flags/:name              — Flag details
POST   /api/admin/flags/:name/enable       — Enable globally
POST   /api/admin/flags/:name/disable      — Disable globally
POST   /api/admin/flags/:name/override     — Tenant override
DELETE /api/admin/flags/:name/override     — Remove override
GET    /api/admin/flags/:name/audit        — Audit log
```

---

## 6. Implementation

### 6.1 Usage in code

```typescript
import { featureFlags } from '@/config/feature-flags';

async function handler(ctx: Context): Promise<void> {
  if (await isEnabled('new-validator', ctx.instance)) {
    return newValidator(ctx);
  }
  return oldValidator(ctx);
}

// src/services/feature-flags.ts
export async function isEnabled(
  flagName: string,
  instance: string
): Promise<boolean> {
  // 1. Check kill switch
  const kill = await redis.get(`flag:kill:${flagName}`);
  if (kill === 'true') return false;

  // 2. Check tenant override
  const override = await redis.get(
    `flag:override:${instance}:${flagName}`
  );
  if (override !== null) return override === 'true';

  // 3. Check global
  const global = await redis.get(`flag:global:${flagName}`);
  if (global !== null) return global === 'true';

  // 4. Check default
  return featureFlags[flagName]?.default ?? false;
}
```

### 6.2 Redis keys

```
flag:global:{flag_name}               — Глобалды мән
flag:override:{instance}:{flag_name}  — Tenant override
flag:kill:{flag_name}                 — Emergency kill
flag:experiment:{flag_name}           — Experiment config
flag:audit:{flag_name}:{timestamp}    — Audit log
```

---

## 7. Feature Flag lifecycle

```
Request (ADR / Feature Request)
  ↓
Create flag in config
  ↓
Phase 1: Canary (5%)
  ↓ (monitoring OK)
Phase 2: Early (20%)
  ↓ (monitoring OK)
Phase 3: Wide (50%)
  ↓ (monitoring OK)
GA (100%)
  ↓ (2 week stable)
Clean up: remove old code path, archive flag
```

### 7.1 Cleanup

```typescript
// When flag becomes GA:
// 1. Remove old code path
// 2. Remove feature flag check
// 3. Archive flag in config (mark as 'archived')
// 4. Keep 2 weeks for rollback safety
```

---

## 8. A/B Testing

```typescript
// Experiment configuration
const experiment = {
  'new-menu-layout': {
    variants: ['A: current', 'B: new design'],
    split: 50, // 50/50
    metrics: ['click_rate', 'order_conversion'],
    duration: '7 days',
  },
};

// In code
const variant = await getExperimentVariant(
  'new-menu-layout',
  instance
);
// Returns 'A' or 'B'
```

---

## 9. Болашақ

- **Automatic rollout:** Monitoring metric-терге байланысты авто-rollout
- **Multi-variant experiments:** A/B/C/D тесттер
- **User-level targeting:** phone/ID бойынша flag
- **Geo-targeting:** Қала/аймақ бойынша flag
- **Schedule:** Белгілі уақытта авто-қосу/өшіру

---

_Author: BekzatAI EOS_

# 26. Billing & Subscription

> **Нұсқа:** 1.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Миссия

Billing — әрбір ресторан өз тұтынуына қарай төлейтін, fair және scalable тарифтік жүйе. Ешқандай бір ресторан басқасының шығынын жаппайды.

---

## 2. Billing модель

### 2.1 Төлем формуласы

```
Айлық төлем = Base Fee + Variable Fee + Add-on Fees
```

| Компонент | Сипаттамасы | Есептеу |
|-----------|-------------|---------|
| **Base Fee** | Платформаны қосу | $49/ай (1 ресторан) |
| **Variable Fee** | LLM тұтыну | $0.002/request (gemini-2.5-flash) |
| **Add-on Fees** | Қосымша модульдер | Модуль сайын $9-29/ай |

### 2.2 Тарифтік жоспарлар

| Feature | Starter | Business | Enterprise |
|---------|---------|----------|------------|
| **Бағасы** | $49/ай | $149/ай | $499/ай |
| **Ресторандар** | 1 | 5 | Unlimited |
| **LLM модель** | gemini-2.5-flash | gpt-4o-mini + gemini | Барлық модельдер |
| **Request лимиті** | 1000/ай | 10000/ай | Unlimited |
| **AI Skills** | 3 skill | Барлық skill | Барлық skill + custom |
| **Оператор қолдау** | Чат | Чат + телефон | Жеке менеджер |
| **API доступ** | Read-only | Read/Write | Full access |
| **SLA** | 99.0% | 99.5% | 99.9% |
| **Support** | Email | Email + Slack | 24/7 Priority |

---

## 3. Billing architecture

```
┌─────────────────────────────────────────────────────┐
│                   Billing Service                      │
├─────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Plan     │  │ Usage    │  │ Invoice           │  │
│  │ Manager  │  │ Tracker  │  │ Generator         │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
│  ┌──────────────────────────────────────────────┐  │
│  │              Payment Gateway                   │  │
│  │  Stripe / Kaspi / Halyk                       │  │
│  └──────────────────────────────────────────────┘  │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐  │
│  │ Metering │  │ Tier     │  │ Subscription     │  │
│  │ (Redis)  │  │ Engine   │  │ State Machine    │  │
│  └──────────┘  └──────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### 3.1 Data flow

```
 Request
   ↓
 1. Rate limiter (Redis) — лимитін тексереді
 2. Usage metering — Redis INCR көмегімен санау
 3. LLM request — қосымша $ есептеледі
 4. Response
 5. Usage flush — Redis → NocoDB (әр сағат)
 6. Invoice — ай соңында генерация
 7. Payment — Stripe / Kaspi / Halyk
```

### 3.2 Redis keys

```
billing:usage:{instance}:{month}          → count
billing:limit:{instance}                  → max requests
billing:plan:{instance}                   → plan name
billing:tier:{instance}                   → tier config
billing:metering:{instance}:{hour}        → hourly count
```

---

## 4. Usage metering

### 4.1 Не метрикаланады?

| Metric | Unit | Қалай есептеледі | Баға |
|--------|------|------------------|------|
| **LLM requests** | 1 request | Redis INCR | $0.002 |
| **LLM tokens** | 1K tokens | OpenRouter response | $0.00015 |
| **WhatsApp messages** | 1 message | Outbound count | $0.005 |
| **Storage** | 1 MB | Redis memory | $0.001 |
| **Skills** | 1 execution | Skill call count | $0.001 |

### 4.2 Metering implementation

```typescript
// src/services/metering.ts
export async function trackUsage(
  instance: string,
  metric: 'llm_request' | 'whatsapp_message' | 'skill_execution'
): Promise<void> {
  const key = `billing:usage:${instance}:${currentMonth()}`;
  await redis.incr(key);
  await redis.expire(key, 60 * 60 * 24 * 35); // 35 days

  const hourlyKey = `billing:metering:${instance}:${currentHour()}`;
  await redis.incr(hourlyKey);
  await redis.expire(hourlyKey, 60 * 60 * 48); // 48 hours
}

export async function checkUsageLimit(
  instance: string
): Promise<boolean> {
  const plan = await getPlan(instance);
  const usage = await redis.get(
    `billing:usage:${instance}:${currentMonth()}`
  );
  const limit = plan.limits.llmRequests;
  return parseInt(usage || '0') < limit;
}
```

---

## 5. Subscription lifecycle

```
Trial (14 days)
  ↓
Active (paid)
  ↓ (лимит таусылды)
Overdue (3 days grace)
  ↓ (төлем жасалды)
Active
  ↓ (grace period өтті)
Suspended (read-only, бот жұмыс істемейді)
  ↓ (төлем жасалды)
Active
  ↓ (30 күн)
Cancelled (деректер 90 күн сақталады)
```

### 5.1 State machine

```typescript
type SubscriptionState =
  | 'trial'
  | 'active'
  | 'overdue'
  | 'suspended'
  | 'cancelled';

// Transitions
'trial' → 'active'         // payment received
'active' → 'overdue'       // billing failed
'overdue' → 'active'       // payment received
'overdue' → 'suspended'    // 3 days passed
'suspended' → 'active'     // payment received
'suspended' → 'cancelled'  // 30 days passed
```

---

## 6. Техникалық ерекшеліктер

### 6.1 Tenant-level billing

- Әрбір ресторан (instance) өз billing-іне ие
- Бір аккаунтта бірнеше ресторан (Business/Enterprise)
- Барлық метрикалар Redis-те сақталады (жылдам INCR үшін)
- NocoDB-ге flush: әр сағат / 1000 request

### 6.2 Rate limiting per plan

```typescript
const planLimits = {
  starter:   { requestsPerMin: 15,  requestsPerMonth: 1000  },
  business:  { requestsPerMin: 60,  requestsPerMonth: 10000 },
  enterprise:{ requestsPerMin: 300, requestsPerMonth: 100000 },
};
```

### 6.3 Invoice generation

- Ай сайын автоматты түрде (cron: `0 0 1 * *`)
- PDF форматта
- Kaspi / Halyk / Stripe арқылы төлем
- Email-ге жіберіледі

### 6.4 Webhook notifications

```typescript
// Billing events → ресторанға notification
'billing.overdue'        → "Төлеміңіз кешікті"
'billing.suspended'      → "Бот тоқтатылды"
'billing.payment.success' → "Төлем қабылданды"
'billing.upgraded'       → "Тариф өзгертілді"
```

---

## 7. AI Skills Marketplace billing

### 7.1 Skill pricing models

| Model | Сипаттамасы | Мысал |
|-------|-------------|-------|
| **Free** | Барлық tenant-тарға ашық | searchMenu |
| **Premium** | $9/ай | loyalty-program |
| **Custom** | Жеке баға | enterprise integration |
| **Revenue Share** | 70/30 (developer/platform) | marketplace skills |

### 7.2 Developer payout

```
Skill Revenue × 0.70 = Developer payout
                 × 0.30 = Platform fee
Payout: ай сайын, Stripe / Kaspi арқылы
```

---

## 8. Future billing features

- **Annual discount:** 2 ай free (жылдық төлем)
- **Usage alerts:** 80%/90%/100% лимит — email/Slack
- **Auto-scaling:** Лимит таусылғанда авто upgrade
- **Custom add-ons:** Қосымша модульдер (print, loyalty, analytics)
- **Reseller program:** Партнерлер үшін жеңілдік

---

_Author: BekzatAI EOS_

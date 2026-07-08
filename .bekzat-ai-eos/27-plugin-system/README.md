# 27. Plugin System & AI Skills Marketplace

> **Нұсқа:** 1.0
> **Соңғы жаңарту:** 2026-07-08
> **Статус:** Active

---

## 1. Миссия

Plugin System — платформаны үшінші тарап разработчиктері кеңейте алатын, модульдік архитектура. AI Skills Marketplace — осы плагиндерді сатып алу/сату платформасы.

---

## 2. Plugin Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Plugin Manager                       │
├──────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │ Registry   │  │ Sandbox    │  │ Lifecycle      │  │
│  │ (loaded)   │  │ (isolated) │  │ (start/stop)   │  │
│  └────────────┘  └────────────┘  └────────────────┘  │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │
│  │ Hooks      │  │ API Access │  │ Config Schema  │  │
│  │ (events)   │  │ (limited)  │  │ (JSON Schema)  │  │
│  └────────────┘  └────────────┘  └────────────────┘  │
│  ┌────────────┐  ┌────────────┐                       │
│  │ Skills     │  │ Billing    │                       │
│  │ (AI tools) │  │ (metering) │                       │
│  └────────────┘  └────────────┘                       │
└──────────────────────────────────────────────────────┘
```

### 2.1 Plugin types

| Type | Сипаттамасы | Мысал |
|------|-------------|-------|
| **Skill** | LLM tool — AI-ге қосымша мүмкіндік | loyalty-program, feedback |
| **Hook** | Event listener — оқиғаларды өңдеу | after-order, before-send |
| **Middleware** | Request/response фильтр | analytics-tracker, censor |
| **UI** | Dashboard компоненті | analytics-chart, print-queue |
| **Integration** | Сыртқы жүйемен байланыс | 1c-integration, yandex-delivery |

### 2.2 Plugin structure (directory)

```
my-plugin/
├── manifest.json          # name, version, hooks, permissions
├── index.ts               # entry point
├── schema.json            # config schema (JSON Schema)
└── README.md              # documentation
```

### 2.3 Plugin manifest

```json
{
  "name": "loyalty-program",
  "version": "1.0.0",
  "type": "skill",
  "description": "Лоялдылық бағдарламасы: баллдар жинау, сыйлықтар",
  "author": "developer@example.com",
  "permissions": ["redis:read", "nocodb:write", "whatsapp:send"],
  "hooks": ["after:order.completed", "before:llm.response"],
  "billing": {
    "model": "premium",
    "price": 9
  },
  "configSchema": {
    "pointsPerOrder": { "type": "number", "default": 10 },
    "welcomeBonus": { "type": "number", "default": 50 }
  }
}
```

---

## 3. Plugin Runtime

### 3.1 Sandbox (изоляция)

- Әрбір plugin жеке sandbox-та жұмыс істейді
- Басқа plugin-дерге қатынай алмайды
- Redis/NocoDB тек manifest-те көрсетілген permission бойынша
- CPU/Memory лимиттері (resource quotas)
- Timeout: 5s (skill), 2s (hook), 10s (integration)

### 3.2 API доступ

```typescript
// Plugin API Interface
interface PluginAPI {
  redis: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttl?: number): Promise<void>;
    incr(key: string): Promise<number>;
  };
  nocodb: {
    get(table: string, id: string): Promise<Record<string, any>>;
    list(table: string, filter?: Record<string, any>): Promise<any[]>;
  };
  whatsapp: {
    send(phone: string, text: string): Promise<void>;
    sendImage(phone: string, url: string): Promise<void>;
  };
  context: {
    getInstance(): string;
    getTenant(): TenantConfig;
    getRequest(): InboundMessage;
  };
}
```

### 3.3 Hooks system

```typescript
// Available hooks
type Hook =
  | 'before:llm.response'       // LLM жауабын өзгерту
  | 'after:llm.response'        // LLM жауабын логирлеу
  | 'after:whatsapp.received'   // Хабарлама келді
  | 'before:whatsapp.send'      // Хабарлама жіберу алдында
  | 'after:order.completed'     // Заказ аяқталды
  | 'after:payment.received'    // Төлем түсті
  | 'on:error'                  // Қате кезінде
  | 'on:incident'               // Инцидент кезінде
```

---

## 4. AI Skills Marketplace

### 4.1 Магазин архитектурасы

```
┌─────────────────────────────────────────────┐
│              Skills Marketplace               │
├─────────────────────────────────────────────┤
│  ┌──────────────┐  ┌────────────────────┐  │
│  │ Listing      │  │ Rating & Reviews   │  │
│  │ (search,     │  │ (1-5 stars,        │  │
│  │  filter,     │  │  verified buyers)  │  │
│  │  category)   │  │                    │  │
│  └──────────────┘  └────────────────────┘  │
│  ┌──────────────┐  ┌────────────────────┐  │
│  │ Purchasing   │  │ Versioning         │  │
│  │ (one-click,  │  │ (semver,           │  │
│  │  free trial) │  │  changelog)        │  │
│  └──────────────┘  └────────────────────┘  │
│  ┌──────────────┐  ┌────────────────────┐  │
│  │ Developer    │  │ Billing            │  │
│  │ Dashboard    │  │ (sales, payouts,   │  │
│  │ (analytics)  │  │  revenue share)    │  │
│  └──────────────┘  └────────────────────┘  │
└─────────────────────────────────────────────┘
```

### 4.2 Skill categories

| Категория | Мысал skills |
|-----------|-------------|
| **Menu & Orders** | searchMenu, orderTracking, menuLink |
| **Payments** | getPaymentDetails, registerReceipt |
| **CRM & Loyalty** | updateCrmLead, loyaltyProgram, referral |
| **Notifications** | orderReady, promoBroadcast, feedbackRequest |
| **Analytics** | salesReport, popularItems, staffRating |
| **Delivery** | deliveryTracking, zoneCheck, courierChat |
| **Integration** | 1cSync, yandexEda, chocofood |

### 4.3 Developer workflow

```
1. Register as developer
2. Create plugin (manifest + code)
3. Submit for review
   └─→ Auto: schema validation, security scan
   └─→ Manual: code review (BekzatAI team)
4. Publish to marketplace
5. Pricing: free / premium / revenue share
6. Monthly payout
```

---

## 5. Plugin Management (Tenant-side)

### 5.1 Plugin lifecycle per tenant

```
Installed → Configured → Enabled → Disabled → Uninstalled
```

### 5.2 Tenant plugin storage

```typescript
// Redis: {instance}:plugins:{plugin_name}
{
  "status": "enabled",
  "config": {
    "pointsPerOrder": 15,
    "welcomeBonus": 100
  },
  "version": "1.2.0",
  "installedAt": "2026-06-01",
  "updatedAt": "2026-07-01"
}
```

### 5.3 Plugin isolation

- Әрбір tenant plugin-дері бөлек іске қосылады
- Бір tenant-тағы plugin өзге tenant-тың дерегіне қатынай алмайды
- Plugin құласа, тек сол tenant-қа әсер етеді

---

## 6. SDK және Developer Experience

### 6.1 Plugin SDK

```bash
npx bekzatai-plugin init my-plugin
# Creates: manifests.json, index.ts, schema.json, README.md
```

### 6.2 Local development

```bash
bekzatai-plugin dev
# Local sandbox with mocked Redis/NocoDB/WhatsApp
```

### 6.3 Testing

```bash
bekzatai-plugin test        # Unit tests
bekzatai-plugin lint        # Plugin validation
bekzatai-plugin security    # Security scan
```

---

## 7. Болашақ

- **Plugin templates** — Старттық шаблондар (skill, hook, integration)
- **AI-assisted development** — LLM көмегімен plugin жазу
- **Plugin analytics** — Қолдану статистикасы
- **Managed plugins** — BekzatAI командасы жазған ресми plugin-дер
- **Plugin composer** — Visual drag-drop plugin құрастыру

---

_Author: BekzatAI EOS_

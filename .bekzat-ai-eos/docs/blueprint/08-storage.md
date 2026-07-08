# Storage Architecture

> **Нұсқа:** 1.0
> **Типі:** Engineering — data storage
> **Автор:** BekzatAI Engineering
> **Статус:** Draft

---

## Purpose

Define what data is stored, where, and how it is accessed. Each storage system serves a specific purpose. Data is stored in the system most appropriate for its access pattern and lifecycle.

---

## Storage Map

```
┌────────────────────────────────────────────────────────────────┐
│                        STORAGE SYSTEMS                          │
├────────────┬───────────┬───────────┬───────────┬──────────────┤
│   REDIS    │    DLE    │  NocoDB   │   FILES   │   ANALYTICS  │
│            │           │           │           │              │
│ Short-term │ Long-term │ Config    │ Assets    │ Metrics      │
│ Session    │ Customer  │ Identity  │ Images    │ Logs         │
│ Cache      │ Orders    │ Plans     │ Templates │ Events       │
│ Rate limit │ Products  │ Features  │ Documents │ Learnings    │
│ Locking    │ Business  │ Plugins   │           │              │
│ Pub/sub    │ Data      │ Billing   │           │              │
├────────────┼───────────┼───────────┼───────────┼──────────────┤
│ Key-Value  │ SQL       │ SQL       │ Object    │ Time-series  │
│ + TTL      │ + Indexed │ + Related │ Store     │ + Search     │
└────────────┴───────────┴───────────┴───────────┴──────────────┘
```

---

## Storage System: Redis

**Purpose:** Fast, ephemeral, in-memory data.

**Role in consciousness:** Short-term memory.

**What it stores:**

| Data Type | Key Pattern | TTL | Purpose |
|-----------|-------------|-----|---------|
| Session | `session:{restaurant}:{customer}` | 24h | Conversation state |
| Context | `context:{restaurant}:{customer}` | 24h | Current conversation context |
| Rate Limit | `ratelimit:{restaurant}:{customer}` | 1min | Rate limiting |
| Lock | `lock:{resource}` | 30s | Mutex for concurrent access |
| Cache (products) | `cache:{restaurant}:products` | 1h | Product data cache |
| Cache (identity) | `cache:{restaurant}:identity` | 1h | Identity config cache |
| Pub/Sub | Event channels | - | Event bus |
| Queue | `queue:{type}` | Until consumed | Async task queue |

**Access patterns:**
- Read-heavy (every message requires session lookup)
- Write-heavy (every message updates context)
- TTL-based expiration (automatic cleanup)

**Status:** ✅ Exists. Well-designed.

**Future:**
- Redis Cluster for horizontal scaling
- Redis Streams for reliable event queue
- Redis JSON for structured context data

---

## Storage System: DLE

**Purpose:** Long-term, persistent business data.

**Role in consciousness:** Business memory — customer profiles, orders, products.

**What it stores:**

| Data Type | Description | Retention |
|-----------|-------------|-----------|
| Products | Menu items, prices, categories | Permanent |
| Customers | Profiles, contact info | Permanent |
| Orders | Complete order history | Permanent |
| Conversations | Full conversation logs | 90 days |
| Preferences | Customer preferences | Permanent |
| Businesses | Restaurant business data | Permanent |

**Access patterns:**
- Lookup by ID (customer, order, product)
- Search (by name, phone, date range)
- Aggregation (total orders, popular items)

**Status:** ✅ Exists. Well-designed.

**Future:**
- Read replicas for analytics queries
- Full-text search on conversations
- Soft-delete for GDPR compliance

---

## Storage System: NocoDB

**Purpose:** Configuration and metadata storage.

**Role in consciousness:** Restaurant personality, configuration, plans.

**What it stores:**

| Data Type | Description | Update Frequency |
|-----------|-------------|-----------------|
| Identity Config | Restaurant personality settings | Monthly |
| Plans | Pricing tiers and limits | Quarterly |
| Feature Flags | Feature availability | Weekly |
| Plugin Config | Plugin settings | Monthly |
| Restaurant Settings | Operating hours, addresses | Monthly |
| Promotions | Active promotions | Weekly |
| API Keys | External service keys | Rarely |

**Access patterns:**
- Read at startup (cache in Redis)
- Read on demand (when identity is needed)
- Write through admin panel

**Status:** ✅ Exists. Well-designed.

**Future:**
- NocoDB → Migrate to dedicated DB if scale requires
- Caching layer for frequent reads
- Audit log for config changes

---

## Storage System: File Storage

**Purpose:** Store large, unstructured data.

**What it stores:**
- Uploaded images (menu items, restaurant photos)
- Generated invoices
- Export files
- Backup archives

**Status:** ❌ Not yet formalized. Currently ad-hoc.

**Future:**
- S3-compatible object store
- CDN for public assets
- Signed URLs for secure access

---

## Storage System: Analytics Store

**Purpose:** Metrics, logs, and learning data.

**Role in consciousness:** Experience and learning.

**What it stores:**

| Data Type | Description | Retention |
|-----------|-------------|-----------|
| Event Logs | All system events | 30 days |
| Metrics | Performance metrics | 90 days |
| Conversation Logs | Full conversations | 90 days |
| Learning Data | Patterns and insights | Permanent |
| Audit Logs | Administrative actions | 1 year |

**Status:** ❌ Not yet formalized. Logs are written to files, not a structured store.

**Future:**
- Time-series database for metrics
- Searchable log store (Elasticsearch or similar)
- Aggregated analytics for business intelligence

---

## Data Access Layer

Engines and services do not access storage directly. They use Repositories.

```typescript
// Repository Interface — stable contract
interface CustomerRepository {
  findById(id: string): Promise<Customer | null>
  findByPhone(phone: string): Promise<Customer | null>
  create(customer: CustomerData): Promise<Customer>
  update(id: string, data: Partial<CustomerData>): Promise<Customer>
  getPreferences(id: string): Promise<CustomerPreferences>
  setPreferences(id: string, prefs: CustomerPreferences): Promise<void>
}

// Implementation — can change without affecting callers
class DLECustomerRepository implements CustomerRepository {
  // Implements CustomerRepository using DLE SQL queries
}
```

**Benefits:**
- Storage system can change without affecting business logic
- Testing is easy (mock repositories)
- Each repository has clear responsibility
- Caching can be added transparently

**Status:** ❌ Does not exist. Storage access is direct.

---

## Data Ownership

| Data | Owned By | Can Be Read By | Can Be Written By |
|------|----------|---------------|-------------------|
| Session | Conversation Module | Conversation Module, Pipeline | Conversation Module |
| Customer Profile | Customer Module | All modules | Customer Module, Admin |
| Order | Order Module | All modules | Order Module, n8n |
| Product | Business Module | All modules | Admin |
| Identity Config | Restaurant Admin | All modules | Admin, Identity Engine |
| Logs | Analytics Module | Admin | All modules (append only) |
| Analytics | Analytics Module | Admin, Business | Analytics Module |

---

## Status Summary

| Storage | Status | Priority |
|---------|--------|----------|
| Redis | ✅ Existing | Stable |
| DLE | ✅ Existing | Stable |
| NocoDB | ✅ Existing | Stable |
| File Storage | ⚠️ Ad-hoc | Low |
| Analytics Store | ❌ Missing | Medium |
| Repository Layer | ❌ Missing | High |

---

_BekzatAI — Data knows where it lives. Code knows how to ask. Never the twain shall mix._

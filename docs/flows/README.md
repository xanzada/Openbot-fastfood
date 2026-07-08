# Data Flows

## 1. Негізгі Data Flow (WhatsApp → Клиент)

```
WhatsApp ←───────────┐
  ↓                  │
POST /webhook/whatsapp
  ↓
verifySecret()
  ↓
guardIncomingMessage()
  ↓
preloadContext()  ───→ Redis (8 parallel get)
  ↓
mediaAnalysis() (image/audio/pdf)
  ↓
syncKanbanEvent()  ───→ n8n (async)
  ↓
saveToHistory()  ───→ Redis
  ↓
Pre-LLM short-circuit (егер runtime жоқ)
  ↓
runFastFoodAgent()
  ├── instructions.ts
  ├── FACTS_CONTEXT
  ├── 7 tools
  └── LLM (gemini-2.5-flash)
  ↓
validateFinalText() ──→ 2-sentence, menu-only, no link in text
  ↓
saveToHistory() ─────→ Redis
  ↓
evaluateForShpor() ──→ NocoDB (async)
  ↓
sendWhatsProResponseSequence() ──→ split (650chunks) + typing + send
  ↓
hasLink? ──→ send separate message
  ↓
markInboundDone() ──→ Redis
```

## 2. Cache Flow

```
getResource()
  ├── fast cache hit? → return
  └── fast cache miss?
      ├── network call
      │   ├── success → update fast cache (set TTL)
      │   │           → update stale backup (long TTL)
      │   │           → return
      │   └── fail → stale backup hit? → return (with stale flag)
      │               → fail? → return fallback
```

## 3. LLM Request Flow

```
User message
  ↓
Context assembly:
  ├── instructions.ts (10 rules)
  ├── FACTS_CONTEXT (JSON)
  ├── chat history (last 120)
  └── detected language
  ↓
system_prompt = rules + facts + lang
  ↓
Agent.generateText()
  ├── LLM decides: tool call or direct response
  ├── loop (max 6 steps):
  │   ├── tool call → execute → result
  │   └── LLM processes result
  └── LLM → final text
  ↓
validateFinalText()
  ↓
Output: { text, hasLink, link, rawText }
```

## 4. Шеткі жағдайлар (Edge Cases)

### Runtime жоқ
- Pre-LLM check: "Қазір асхана жабық"
- finalValidator: kitchen-related сөйлемдерді block
- wait_time=0: wait туралы сөйлемдерді block

### Сілтеме сұрауы
- sendMenuLink skill → URL қайтарады
- text: "Алдыңғы сілтемемен тапсырыс бере аласыз." (link sent бұрын)
- WhatsApp-қа жеке хабарлама ретінде жіберіледі

### Спам / Дубликат
- guardIncomingMessage → блок + mute

### Жоғалған/өшкен сілтеме
- magicLink.ts кеңейтілген тізім
- LINK_FORCE_RESEND_RE → "сілтеме", "жоғалып", etc.

### Медиа өңдеу
- video → reject
- image → analyzeMedia (gemini-2.5-flash-lite)
- audio → transcribe
- pdf → analyze

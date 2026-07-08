# Gateway / Guard Layer

## inboundGuard.service.ts

Кіріс WhatsApp хабарламаларын фильтрлеу — спам/дубликат/мут қорғанысы.

### Гвард тізбегі

1. **fromMe check** → Өз хабарламаңды өңдеме
2. **bad_instance** → instanceId форматын тексеру (/^[a-zA-Z0-9_-]{2,64}$/)
3. **bad_phone** → Телефон форматын тексеру (/^\d{10,15}$/)
4. **private_contact_keyword** → Қызметкерлердің жеке контактілерін блоктау (28+ кілт сөз)
5. **saved_contact** → Егер BOT_IGNORE_SAVED_CONTACTS=true болса, сақталған контактілерді өткізбеу
6. **duplicate_done** → Өңделген хабарламаларды блоктау (msg_done key, 24h TTL)
7. **duplicate_processing** → Ағымдағы өңдеудегі хабарлама (NX lock, 3min TTL)
8. **operator_mute** → Оператор mute (max 5min)
9. **duplicate_text** → SHA1 hash негізіндегі дубликат (5s window)
10. **spam_limit** → 15 хабар/минут, 6+ → mute 15мин

### Guard Response

```typescript
interface GuardResult {
  allowed: boolean
  reason?: string
  details?: {
    fromMe?: boolean
    type?: string
    ttl?: number
    remaining?: string
  }
}
```

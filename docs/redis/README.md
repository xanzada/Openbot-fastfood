# Redis Usage

## Connection
- redisClient: global singleton
- connectRedis(): lazy connect, бір рет қана
- Әрбір Redis операциясы safeRedis() арқылы

## Key Schema (18 түрлі key)

### Chat History
```
history:{instanceId}:{phone}
Type: List
TTL: 604800 (7 күн)
Max: 120 items
Format: JSON { role, text, createdAt, ... }
Function: getChatHistory(), saveToHistory()
```

### Language Cache
```
lang:{instanceId}:{phone}
Type: String
TTL: 43200 (12 сағат)
Value: "kk" | "ru"
Function: getUserLang(), saveUserLang()
```

### Magic Link State
```
has_sent_link:{instanceId}:{phone}
Type: String
TTL: 2592000 (30 күн)
Value: timestamp
Function: hasMagicLinkBeenSent(), markMagicLinkSent()
```

### Shift Notes
```
shift_note:{instanceId}:{id}
Type: String
TTL: 86400 (24 сағат)
Format: JSON { text, createdAt, expiresAt }
Function: saveShiftNote(), deleteShiftNote(), getActiveShiftNotes()
```

### Runtime Status Cache
```
runtime_status:{instanceId}
TTL: 5 секунд
Backup: runtime_status_backup:{instanceId} (10 минут)
```

### Restaurant Config Cache
```
config:{instanceId}
TTL: 300 (5 минут)
Backup: config_backup:{instanceId} (7 күн)
```

### Menu Cache
```
menu_context:{instanceId}:{lang}
TTL: 300 (5 минут)
Backup: menu_context_backup:{instanceId}:{lang} (1 күн)
```

### Shpor Cache
```
shpor_context_100:{instanceId}
TTL: 3600 (1 сағат)
Limit: 100 records
```

### Inbound Guards
```
spam:{instanceId}:{phone}        TTL: 60 (1 мин)  Counter
mute:{instanceId}:{phone}        TTL: 900 (15 мин) Spam block
anti_dup:{instanceId}:{phone}    TTL: 5 (сек)     Text hash
msg_done:{instanceId}:{msgId}    TTL: 86400 (1 күн) Completed
msg_processing:{instanceId}:{msgId} TTL: 180 (3 мин) Lock
```

### Media Cache
```
complaint_media:{instanceId}:{phone}  TTL: 300 (5 мин)
media_context:{instanceId}:{phone}    TTL: 60 (1 мин)
```

### Analytics
```
daily_logs:{instanceId}  TTL: 172800 (2 күн) List
```

## Dependency Graph
- redis.service.ts — ең көп importталатын сервис (10 файл)
- dle.service.ts redis-ке тәуелді (cache)
- nocodb.service.ts redis-ке тәуелді (cache)
- inboundGuard.service.ts redis-ке тәуелді (guard)
- Әрбір skill (escalation, menuLink) redis-ке тәуелді

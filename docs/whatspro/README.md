# WhatsPro Integration

WhatsPro — WhatsApp бизнес API шлюзі. HTTP REST арқылы жұмыс істейді.

## Конфигурация

```
WHATSAPP_PRO_API_URL  - Base URL
WHATSAPP_PRO_TOKEN    - Bearer token
WHATSAPP_PRO_PHONE    - Default phone ID
```

## API Endpoints

### POST /api/phone/{phone}/send
Хабарлама жіберу.

### GET /api/phone/{phone}/screenshot
Экран скриншоты (диагностика).

### GET /api/phone/{phone}/contacts
Контактілер синхрондау.

## Message Chunking

`splitWhatsProResponse()` функциясы:
- Хабарламаны 650 символдық бөліктерге бөледі
- Әрбір бөлік бөлек жіберіледі
- URL-дерді жеке хабарлама ретінде бөліп шығарады
- 1.5-3 секунд typing delay

## Typing Indicator

- Хабарламаны жібермес бұрын typing presence жібереді
- 1.5-3 секунд кідіріс (адам сияқты теру әсері)
- Кідіріс әрбір chunk үшін 1 секунд

## Шеткі жағдайлар

- **fromMe check:** Өз хабарламаларыңды өңдемейді
- **Error handling:** Қате кетсе → developerNotify, хабарлама жоғалмайды
- **Rate limiting:** Клиент жағында limiter жоқ, API-ға тәуелді

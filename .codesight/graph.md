# Dependency Graph

## Most Imported Files (change these carefully)

- `src\context\types.ts` — imported by **11** files
- `src\services\redis.service.ts` — imported by **8** files
- `src\services\dle.service.ts` — imported by **5** files
- `src\services\nocodb.service.ts` — imported by **4** files
- `src\transport\whatspro.client.ts` — imported by **3** files
- `src\services\diagnostics.service.ts` — imported by **2** files
- `src\services\developerNotify.service.ts` — imported by **2** files
- `src\context\buildFactsPrompt.ts` — imported by **1** files
- `src\skills\index.ts` — imported by **1** files
- `src\agent\instructions.ts` — imported by **1** files
- `src\agent\finalValidator.ts` — imported by **1** files
- `src\utils\language.ts` — imported by **1** files
- `src\utils\magicLink.ts` — imported by **1** files
- `src\context\preloadContext.ts` — imported by **1** files
- `src\agent\fastfoodAgent.ts` — imported by **1** files
- `src\services\kanbanSync.service.ts` — imported by **1** files
- `src\routes\whatsappWebhook.route.ts` — imported by **1** files
- `src\routes\system.route.ts` — imported by **1** files
- `src\skills\searchMenu.skill.ts` — imported by **1** files
- `src\skills\payment.skill.ts` — imported by **1** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\context\buildFactsPrompt.ts`, `src\context\preloadContext.ts`, `src\services\kanbanSync.service.ts` +6 more
- `src\services\redis.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`, `src\server.ts`, `src\services\diagnostics.service.ts`, `src\services\dle.service.ts` +3 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\routes\system.route.ts`, `src\skills\crm.skill.ts`, `src\skills\payment.skill.ts`, `src\skills\searchMenu.skill.ts`
- `src\services\nocodb.service.ts` ← `src\context\preloadContext.ts`, `src\routes\system.route.ts`, `src\services\developerNotify.service.ts`, `src\skills\escalation.skill.ts`
- `src\transport\whatspro.client.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\developerNotify.service.ts`
- `src\services\diagnostics.service.ts` ← `src\routes\system.route.ts`, `src\server.ts`
- `src\services\developerNotify.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\context\buildFactsPrompt.ts` ← `src\agent\fastfoodAgent.ts`
- `src\skills\index.ts` ← `src\agent\fastfoodAgent.ts`
- `src\agent\instructions.ts` ← `src\agent\fastfoodAgent.ts`

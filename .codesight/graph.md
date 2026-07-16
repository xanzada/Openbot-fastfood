# Dependency Graph

## Most Imported Files (change these carefully)

- `src\context\types.ts` — imported by **15** files
- `src\services\redis.service.ts` — imported by **10** files
- `src\services\dle.service.ts` — imported by **9** files
- `src\services\nocodb.service.ts` — imported by **7** files
- `src\transport\whatspro.client.ts` — imported by **5** files
- `src\services\diagnostics.service.ts` — imported by **2** files
- `src\services\tenantAuth.service.ts` — imported by **2** files
- `src\services\developerNotify.service.ts` — imported by **2** files
- `src\context\buildFactsPrompt.ts` — imported by **1** files
- `src\skills\index.ts` — imported by **1** files
- `src\agent\instructions.ts` — imported by **1** files
- `src\agent\finalValidator.ts` — imported by **1** files
- `src\agent\modelRouter.ts` — imported by **1** files
- `src\utils\language.ts` — imported by **1** files
- `src\utils\magicLink.ts` — imported by **1** files
- `src\controllers\kanban.ts` — imported by **1** files
- `src\context\preloadContext.ts` — imported by **1** files
- `src\agent\fastfoodAgent.ts` — imported by **1** files
- `src\services\kanbanSync.service.ts` — imported by **1** files
- `src\services\mediaAnalysis.service.ts` — imported by **1** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\agent\modelRouter.ts`, `src\context\buildFactsPrompt.ts`, `src\context\preloadContext.ts` +10 more
- `src\services\redis.service.ts` ← `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\whatsappWebhook.route.ts`, `src\server.ts`, `src\services\diagnostics.service.ts` +5 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts` +4 more
- `src\services\nocodb.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts` +2 more
- `src\transport\whatspro.client.ts` ← `src\controllers\kanban.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\developerNotify.service.ts`, `src\skills\escalation.skill.ts`
- `src\services\diagnostics.service.ts` ← `src\routes\system.route.ts`, `src\server.ts`
- `src\services\tenantAuth.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\services\developerNotify.service.ts` ← `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\context\buildFactsPrompt.ts` ← `src\agent\fastfoodAgent.ts`
- `src\skills\index.ts` ← `src\agent\fastfoodAgent.ts`

# Dependency Graph

## Most Imported Files (change these carefully)

- `src\context\types.ts` — imported by **18** files
- `src\services\nocodb.service.ts` — imported by **11** files
- `src\services\dle.service.ts` — imported by **9** files
- `src\services\redis.service.ts` — imported by **9** files
- `src\services\developerNotify.service.ts` — imported by **4** files
- `src\transport\whatspro.client.ts` — imported by **4** files
- `src\services\auditLogger.service.ts` — imported by **4** files
- `src\services\llm.service.ts` — imported by **4** files
- `src\services\tenantAuth.service.ts` — imported by **3** files
- `src\utils\language.ts` — imported by **2** files
- `src\services\diagnostics.service.ts` — imported by **2** files
- `src\context\buildFactsPrompt.ts` — imported by **1** files
- `src\skills\index.ts` — imported by **1** files
- `src\agent\instructions.ts` — imported by **1** files
- `src\agent\finalValidator.ts` — imported by **1** files
- `src\agent\modelRouter.ts` — imported by **1** files
- `src\agent\persona.ts` — imported by **1** files
- `src\utils\magicLink.ts` — imported by **1** files
- `src\controllers\kanban.ts` — imported by **1** files
- `src\context\preloadContext.ts` — imported by **1** files

## Import Map (who imports what)

- `src\context\types.ts` ← `src\agent\fastfoodAgent.ts`, `src\agent\finalValidator.ts`, `src\agent\modelRouter.ts`, `src\agent\persona.ts`, `src\context\buildFactsPrompt.ts` +13 more
- `src\services\nocodb.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts` +6 more
- `src\services\dle.service.ts` ← `src\context\preloadContext.ts`, `src\controllers\kanban.ts`, `src\cron\statsCron.ts`, `src\routes\whatsappWebhook.route.ts`, `src\skills\checkOrderStatus.skill.ts` +4 more
- `src\services\redis.service.ts` ← `src\cron\statsCron.ts`, `src\server.ts`, `src\services\complaintRouting.service.ts`, `src\services\diagnostics.service.ts`, `src\services\inboundGuard.service.ts` +4 more
- `src\services\developerNotify.service.ts` ← `src\controllers\kanban.ts`, `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\transport\whatspro.client.ts` ← `src\controllers\kanban.ts`, `src\routes\whatsappWebhook.route.ts`, `src\services\complaintRouting.service.ts`, `src\services\developerNotify.service.ts`
- `src\services\auditLogger.service.ts` ← `src\controllers\kanban.ts`, `src\routes\dleWebhook.route.ts`, `src\services\dle.service.ts`, `src\transport\whatspro.client.ts`
- `src\services\llm.service.ts` ← `src\routes\whatsappWebhook.route.ts`, `src\services\diagnostics.service.ts`, `src\services\mediaAnalysis.service.ts`, `src\utils\language.ts`
- `src\services\tenantAuth.service.ts` ← `src\routes\dleWebhook.route.ts`, `src\routes\system.route.ts`, `src\routes\whatsappWebhook.route.ts`
- `src\utils\language.ts` ← `src\context\preloadContext.ts`, `test\languageAndReceipt.test.ts`

# Prompt system

OpenBot uses three clearly separated layers:

1. `src/agent/instructions.ts` — stable runtime constitution, safety, tool
   contracts, tenant isolation, and autonomous decision principles.
2. Tenants platform `system_prompt` — brand voice and local policy. This layer
   cannot override the core constitution.
3. `FACTS_CONTEXT` — current tenant-scoped facts, recent conversation, live
   operational state, and tool inputs.

NocoDB is not a prompt or configuration source. The Tenants platform owns tenant
configuration; Redis owns short-lived conversation and operational state; DLE
and `api_bot.php` remain the source of menu/order/payment business data.

`src/agent/universal_platform_prompt.md` and the files named `Бот промп.txt` are
human-readable references. They are intentionally not loaded as a second system
prompt. Runtime truth remains in `instructions.ts`, which prevents stale prompt
copies from silently changing production behavior.

High-confidence live-data intents are enforced by `src/agent/toolPolicy.ts`.
Ordinary conversation and unfamiliar situations remain model-decided. The final
validator protects hard factual and transport contracts; it does not replace a
useful answer merely because wording is mixed or unexpected.

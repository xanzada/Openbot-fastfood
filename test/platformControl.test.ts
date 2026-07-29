import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeRestaurantConfig } from "../src/services/platformConfig.service.js";

test("platform bot control is checked before AI processing", async () => {
  const route = await readFile(new URL("../src/routes/whatsappWebhook.route.ts", import.meta.url), "utf8");
  const processStart = route.indexOf("async function processWhatsAppWebhook");
  const guardStart = route.indexOf("const guard = await guardIncomingMessage", processStart);
  const pauseCheck = route.indexOf("await isTenantBotEnabled(instanceId)", processStart);
  assert.ok(processStart >= 0 && pauseCheck > processStart);
  assert.ok(pauseCheck < guardStart, "paused messages are ignored before the AI/inbound pipeline starts");
  assert.match(route.slice(pauseCheck, guardStart), /markInboundDone\(instanceId, messageId\)/);
});

test("developer alerts have an Environment fallback and no NocoDB dependency", async () => {
  const notify = await readFile(new URL("../src/services/developerNotify.service.ts", import.meta.url), "utf8");
  const platform = await readFile(new URL("../src/services/platformConfig.service.ts", import.meta.url), "utf8");
  assert.match(notify, /process\.env\.OPENBOT_DEVELOPER_PHONE/);
  assert.doesNotMatch(`${notify}\n${platform}`, /nocodb/i);
  assert.match(platform, /bot_enabled/);
});

test("platform config refuses a response belonging to another tenant", () => {
  assert.equal(
    normalizeRestaurantConfig(
      { instance_id: "beta", brand: "Beta", system_prompt: "Beta-only prompt" },
      "alpha"
    ),
    null
  );
  const alpha = normalizeRestaurantConfig(
    { instance_id: "alpha", brand: "Alpha", system_prompt: "Alpha-only prompt" },
    "alpha"
  );
  assert.equal(alpha?.instance_id, "alpha");
  assert.equal(alpha?.system_prompt, "Alpha-only prompt");
});

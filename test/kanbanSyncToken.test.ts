import test from "node:test";
import assert from "node:assert/strict";
import { pickWebhookToken } from "../src/services/kanbanSync.service.js";

// The legacy n8n hook is off for every current tenant (no n8n_webhook_url), but
// its token chain ended in `secret_key` - which on `prestige` is the Alemi HMAC
// signing secret. Anyone enabling the hook would have posted the tenant's
// signing key to a third-party endpoint in plain text.
test("the outbound hook never borrows the tenant signing secret as its token", () => {
  assert.equal(pickWebhookToken({
    secret_key: "alemi-hmac-secret",
    secret_token: "some-other-secret",
    crm_secret_token: "crm-secret",
  }), "");
});

test("a token minted for this hook is used, under any of its documented names", () => {
  assert.equal(pickWebhookToken({ n8n_webhook_token: "hook-1", secret_key: "alemi" }), "hook-1");
  assert.equal(pickWebhookToken({ n8nWebhookToken: "hook-2" }), "hook-2");
  assert.equal(pickWebhookToken({ n8n_token: "hook-3" }), "hook-3");
  assert.equal(pickWebhookToken({ kanban_webhook_token: "hook-4" }), "hook-4");
  assert.equal(pickWebhookToken({}), "");
});

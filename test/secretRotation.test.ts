import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AlemiTransportRequest } from "../src/services/alemiApi.service.js";

// Redis is intentionally unreachable: the cache layer fails open, so these tests
// exercise the in-process cache plus the platform read without external state.
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { verifyTenantSecretWithRotationRefresh } = await import("../src/routes/dleWebhook.route.js");
const {
  ALEMI_COMMAND_PATH,
  callAlemiCommand,
} = await import("../src/services/alemiApi.service.js");
const { getRestaurantConfig, refreshRestaurantConfig } = await import("../src/services/platformConfig.service.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

function kanbanRequest(token: string, instance = "prestige") {
  return { headers: {}, body: { instance }, query: { token } };
}

test("a rotated Alemi Secret Key is accepted after exactly one forced config refresh", async () => {
  const staleConfig = { instance_id: "prestige", alemi_secret: "old-secret" };
  const freshConfig = { instance_id: "prestige", alemi_secret: "new-secret" };
  let refreshes = 0;
  const accepted = await verifyTenantSecretWithRotationRefresh(
    kanbanRequest("new-secret") as any,
    "prestige",
    {
      config: staleConfig,
      refreshConfig: async () => {
        refreshes += 1;
        return freshConfig;
      },
    },
  );
  assert.equal(refreshes, 1);
  assert.equal(accepted?.alemi_secret, "new-secret");
});

test("a genuinely wrong token still gets 403 after a single refresh attempt", async () => {
  let refreshes = 0;
  let loads = 0;
  await assert.rejects(
    () => verifyTenantSecretWithRotationRefresh(kanbanRequest("attacker-token") as any, "prestige", {
      loadConfig: async () => {
        loads += 1;
        return { instance_id: "prestige", alemi_secret: "current-secret" };
      },
      refreshConfig: async () => {
        refreshes += 1;
        return { instance_id: "prestige", alemi_secret: "current-secret" };
      },
    }),
    (error: any) => error?.message === "INVALID_TENANT_SECRET" && error?.statusCode === 403,
  );
  assert.equal(loads, 1);
  assert.equal(refreshes, 1, "the forced re-read never loops");
});

test("a tenant with no configured secret still denies without a refresh", async () => {
  let refreshes = 0;
  await assert.rejects(
    () => verifyTenantSecretWithRotationRefresh(kanbanRequest("anything", "nameless") as any, "nameless", {
      config: { instance_id: "nameless" },
      refreshConfig: async () => {
        refreshes += 1;
        return { instance_id: "nameless", alemi_secret: "whatever" };
      },
    }),
    (error: any) => error?.message === "TENANT_SECRET_NOT_CONFIGURED" && error?.statusCode === 500,
  );
  assert.equal(refreshes, 0);
});

function signatureOf(request: AlemiTransportRequest) {
  return String(request.headers["X-Command-Signature"] || "");
}

function expectedSignature(secret: string, timestamp: string, body: string) {
  return `v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

test("a hub 401 triggers one forced refresh and exactly one resigned retry", async () => {
  const sent: AlemiTransportRequest[] = [];
  let refreshes = 0;
  const result = await callAlemiCommand("prestige", "runtime.status.get", {}, {
    config: { instance_id: "prestige", alemi_secret: "old-secret" },
    refreshConfig: async () => {
      refreshes += 1;
      return { instance_id: "prestige", alemi_secret: "new-secret" };
    },
    nowMs: 1_700_000_000_000,
    transport: async (request) => {
      sent.push(request);
      if (sent.length === 1) return { status: 401, data: { ok: false } };
      return { status: 200, data: { ok: true, result: { state: "ready" } } };
    },
  });
  assert.deepEqual(result, { state: "ready" });
  assert.equal(sent.length, 2);
  assert.equal(refreshes, 1);
  assert.equal(sent[0].url, `https://hub.alemi.kz${ALEMI_COMMAND_PATH}`);
  assert.equal(signatureOf(sent[0]), expectedSignature("old-secret", "1700000000", String(sent[0].body)));
  assert.equal(signatureOf(sent[1]), expectedSignature("new-secret", "1700000000", String(sent[1].body)));
  // The retry must BE a retry. It used to re-enter buildAlemiSignedCommand with
  // no id and mint a new command_id, so a write the hub had already accepted
  // before the secret rotated came back looking like a different command and
  // hub-side idempotency could not dedupe it.
  assert.equal(sent[0].headers["X-Command-Id"], sent[1].headers["X-Command-Id"]);
  assert.equal(JSON.parse(String(sent[0].body)).command_id, JSON.parse(String(sent[1].body)).command_id);
});

test("a second hub 401 surfaces instead of retrying again", async () => {
  let attempts = 0;
  let refreshes = 0;
  await assert.rejects(
    () => callAlemiCommand("prestige", "runtime.status.get", {}, {
      config: { instance_id: "prestige", alemi_secret: "old-secret" },
      refreshConfig: async () => {
        refreshes += 1;
        return { instance_id: "prestige", alemi_secret: "still-wrong" };
      },
      transport: async () => {
        attempts += 1;
        return { status: 401, data: { ok: false } };
      },
    }),
    (error: any) => error?.message === "ALEMI_HTTP_401" && error?.statusCode === 401,
  );
  assert.equal(attempts, 2, "at most one retry");
  assert.equal(refreshes, 1);
});

test("a failed forced refresh keeps the original 401 and does not retry", async () => {
  let attempts = 0;
  await assert.rejects(
    () => callAlemiCommand("prestige", "runtime.status.get", {}, {
      config: { instance_id: "prestige", alemi_secret: "old-secret" },
      refreshConfig: async () => null,
      transport: async () => {
        attempts += 1;
        return { status: 401, data: { ok: false } };
      },
    }),
    (error: any) => error?.message === "ALEMI_HTTP_401",
  );
  assert.equal(attempts, 1);
});

test("a forced refresh bypasses the caches and never falls back to the stale backup", async () => {
  let secret = "old-secret";
  let healthy = true;
  const server = http.createServer((req, res) => {
    if (!healthy) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ config: { instance_id: "rotation_test", alemi_secret: secret } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const before = {
    base: process.env.TENANTS_PLATFORM_BASE_URL,
    token: process.env.TENANTS_PLATFORM_API_TOKEN,
  };
  process.env.TENANTS_PLATFORM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TENANTS_PLATFORM_API_TOKEN = "platform-token";

  try {
    const first = await getRestaurantConfig("rotation_test");
    assert.equal(first?.alemi_secret, "old-secret");

    secret = "new-secret";
    const cached = await getRestaurantConfig("rotation_test");
    assert.equal(cached?.alemi_secret, "old-secret", "the normal read is still cached");

    const refreshed = await refreshRestaurantConfig("rotation_test");
    assert.equal(refreshed?.alemi_secret, "new-secret");
    const afterRefresh = await getRestaurantConfig("rotation_test");
    assert.equal(afterRefresh?.alemi_secret, "new-secret", "the refresh rewrote the caches");

    healthy = false;
    assert.equal(await refreshRestaurantConfig("rotation_test"), null, "no stale fallback on a forced refresh");
    const stillCached = await getRestaurantConfig("rotation_test");
    assert.equal(stillCached?.alemi_secret, "new-secret", "normal reads keep the tenant alive");
  } finally {
    if (before.base === undefined) delete process.env.TENANTS_PLATFORM_BASE_URL;
    else process.env.TENANTS_PLATFORM_BASE_URL = before.base;
    if (before.token === undefined) delete process.env.TENANTS_PLATFORM_API_TOKEN;
    else process.env.TENANTS_PLATFORM_API_TOKEN = before.token;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

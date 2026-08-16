import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

// Exercise the platform boundary without depending on an external Redis.
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.REDIS_CONNECT_TIMEOUT_MS = "500";
process.env.REDIS_OPERATION_TIMEOUT_MS = "500";

const { getRestaurantConfig } = await import("../src/services/platformConfig.service.js");
const { redisClient } = await import("../src/services/redis.service.js");

test.after(() => {
  if (redisClient.isOpen) redisClient.destroy();
});

test("platform config keeps two restaurant instances and secrets isolated", async () => {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(String(req.url || ""));
    const instance = decodeURIComponent(String(req.url || "").split("/").filter(Boolean).at(-1) || "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      config: {
        instance_id: instance,
        alemi_secret: `${instance}-secret`,
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const beforeBase = process.env.TENANTS_PLATFORM_BASE_URL;
  const beforeToken = process.env.TENANTS_PLATFORM_API_TOKEN;
  process.env.TENANTS_PLATFORM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TENANTS_PLATFORM_API_TOKEN = "platform-token";

  try {
    const alpha = await getRestaurantConfig("saas-alpha");
    const beta = await getRestaurantConfig("saas-beta");
    assert.equal(alpha?.instance_id, "saas-alpha");
    assert.equal(alpha?.alemi_secret, "saas-alpha-secret");
    assert.equal(beta?.instance_id, "saas-beta");
    assert.equal(beta?.alemi_secret, "saas-beta-secret");
    assert.notEqual(alpha?.alemi_secret, beta?.alemi_secret);
    assert.deepEqual(requests, [
      "/api/wa/runtime-configs/saas-alpha",
      "/api/wa/runtime-configs/saas-beta",
    ]);
  } finally {
    if (beforeBase === undefined) delete process.env.TENANTS_PLATFORM_BASE_URL;
    else process.env.TENANTS_PLATFORM_BASE_URL = beforeBase;
    if (beforeToken === undefined) delete process.env.TENANTS_PLATFORM_API_TOKEN;
    else process.env.TENANTS_PLATFORM_API_TOKEN = beforeToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("platform config fails closed before cache or network when instance id is empty", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      config: {
        instance_id: "some-other-restaurant",
        alemi_secret: "must-not-be-borrowed",
      },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const beforeBase = process.env.TENANTS_PLATFORM_BASE_URL;
  const beforeToken = process.env.TENANTS_PLATFORM_API_TOKEN;
  process.env.TENANTS_PLATFORM_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.TENANTS_PLATFORM_API_TOKEN = "platform-token";

  try {
    assert.equal(await getRestaurantConfig(""), null);
    assert.equal(requests, 0, "an unidentified caller must not hit the platform collection path");
  } finally {
    if (beforeBase === undefined) delete process.env.TENANTS_PLATFORM_BASE_URL;
    else process.env.TENANTS_PLATFORM_BASE_URL = beforeBase;
    if (beforeToken === undefined) delete process.env.TENANTS_PLATFORM_API_TOKEN;
    else process.env.TENANTS_PLATFORM_API_TOKEN = beforeToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

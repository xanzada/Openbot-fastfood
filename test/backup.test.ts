import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { describe, it } from "node:test";

// These artefacts are deployment inputs, not application code: docker-compose.yml and
// backup/*.sh are not copied into the container image. Reading them at import time made
// the SUITE RESULT depend on the checkout shape - it threw outside a full checkout and
// could never run in the deployed image (found 2026-08-22). Skip cleanly instead.
const root = join(process.cwd());
const artefacts = ["docker-compose.yml", join("backup", "backup.sh"), join("backup", "restore.sh")];
const artefactsPresent = artefacts.every((relative) => existsSync(join(root, relative)));
const read = (relative: string) => (artefactsPresent ? readFileSync(join(root, relative), "utf8") : "");

const compose = read("docker-compose.yml");
const backup = read(join("backup", "backup.sh"));
const restore = read(join("backup", "restore.sh"));

describe("encrypted offsite backup", { skip: artefactsPresent ? false : "deployment artefacts are not present in this checkout" }, () => {
  it("mounts only backup state and protects credentials behind env values", () => {
    assert.match(compose, /backup_state:\/work/);
    assert.match(compose, /openbot_state:\/source\/openbot_state:ro/);
    assert.match(compose, /BACKUP_ENABLED: \$\{BACKUP_ENABLED:-false\}/);
    assert.doesNotMatch(backup, /BEGIN OPENSSH PRIVATE KEY/);
  });

  it("encrypts, splits and alternates snapshot branches", () => {
    assert.match(backup, /age -r "\$\{recipient\}"/);
    assert.match(backup, /split -b 90m/);
    assert.match(backup, /StrictHostKeyChecking=yes/);
    assert.match(backup, /BACKUP_GIT_BRANCH_PREFIX\}-\$\{slot\}/);
  });

  it("verifies both encrypted and decrypted checksums during restore", () => {
    assert.match(restore, /sha256sum -c encrypted-parts\.sha256/);
    assert.match(restore, /age -d -i/);
    assert.match(restore, /redisSha256/);
    assert.match(restore, /openbotStateSha256/);
    assert.match(backup, /openbot-state\.tar/);
  });
});

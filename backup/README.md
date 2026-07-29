# Encrypted OpenBot backups

This sidecar exports the persistent OpenBot Redis database every 15 minutes by
default. Each export is compressed, encrypted before leaving the server, split
below GitHub's per-file limit, and force-pushed to alternating private branches:

- `snapshot-openbot-a`
- `snapshot-openbot-b`

The decryption identity must stay off the server. See the matching WhatsPro
backup vault documentation for the complete recovery procedure.

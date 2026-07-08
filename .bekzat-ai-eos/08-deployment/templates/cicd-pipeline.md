# CI/CD Pipeline

> **Нұсқа:** 1.0
> **Platform:** GitHub Actions

---

## Pipeline Diagram

```
Push → Build → Lint → Test → Docker Build → Push to Registry → Deploy → Smoke Test
```

## Workflow

### On Push (feature/*, fix/*)

- Build (`npm run build`)
- Lint (`npm run lint`)
- Test — unit (`npm test`)

### On Push to main

- Build
- Lint
- Test (unit + integration)
- Docker build & push (tag: latest + commit SHA)
- Deploy to staging (SSH)
- Smoke test (health check + test message)
- **Manual approval** → Deploy to production

### On Tag (v*.*.*)

- Full build
- Docker build & push with semver tag
- Deploy to production (zero-downtime)
- Smoke test

## GitHub Actions

```yaml
name: CI/CD
on:
  push:
    branches: [main, 'feature/**', 'fix/**']
    tags: ['v*']
  pull_request:
    branches: [main]

env:
  REGISTRY: ghcr.io
  IMAGE_NAME: ${{ github.repository }}

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
      
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test

  build-and-push:
    needs: test
    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    
    steps:
      - uses: actions/checkout@v4
      
      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: ${{ env.REGISTRY }}
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      
      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}
          tags: |
            type=sha,prefix=,format=short
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=raw,value=latest,enable=${{ github.ref == 'refs/heads/main' }}
      
      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}

  deploy:
    needs: build-and-push
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main' || startsWith(github.ref, 'refs/tags/v')
    
    steps:
      - name: Deploy via SSH
        uses: appleboy/ssh-action@v1.0.0
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_KEY }}
          script: |
            cd /opt/openbot-fastfood
            docker compose pull app
            docker compose up -d app --force-recreate
            sleep 10
            curl -f http://localhost:4100/health || (docker compose logs app && exit 1)
```

## Deployment Script (Manual)

```bash
#!/bin/bash
set -euo pipefail

TAG=${1:-latest}
echo "Deploying $TAG..."

export IMAGE_TAG=$TAG
docker compose pull app
docker compose up -d app --force-recreate

echo "Waiting for health check..."
for i in {1..12}; do
  if curl -sf http://localhost:4100/health > /dev/null 2>&1; then
    echo "Health check passed!"
    exit 0
  fi
  sleep 5
done

echo "Health check failed!"
docker compose logs app --tail=50
exit 1
```

## Rollback Script

```bash
#!/bin/bash
set -euo pipefail

PREVIOUS_TAG=${1:?Previous tag required}

echo "Rolling back to $PREVIOUS_TAG..."
export IMAGE_TAG=$PREVIOUS_TAG
docker compose up -d app --force-recreate

sleep 10
curl -f http://localhost:4100/health && echo "Rollback successful" || echo "Rollback failed"
```

---

_Author: BekzatAI EOS_

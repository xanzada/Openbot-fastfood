FROM node:20-bullseye-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && chown -R node:node /app

ENV NODE_ENV=production
EXPOSE 4100
USER node

CMD ["node", "dist/server.js"]

FROM node:20-bullseye-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm install --save-dev typescript @types/node @types/express && npm run build && npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 4100
CMD ["node", "dist/server.js"]

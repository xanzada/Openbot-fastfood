FROM node:20-bullseye-slim

WORKDIR /app

# 1. Тек package файлдарын көшіру (Docker кэшін тиімді қолдану үшін)
COPY package*.json ./

# 2. БАРЛЫҚ кітапханаларды (dev қоса) таза орнату
RUN npm ci

# 3. Басқа конфигурациялар мен кодты көшіру
COPY tsconfig.json ./
COPY src ./src



# 5. Продакшнға керек емес (dev) кітапханаларды өшіріп, контейнерді жеңілдету
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "dist/server.js"]

FROM node:20-bullseye-slim

WORKDIR /app

# Copy package files first for Docker layer caching
COPY package*.json ./

# Install ALL dependencies (including devDependencies needed for build)
RUN npm ci

# Copy config and source
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript to dist/
RUN npm run build

# Remove dev dependencies — only production deps remain in the image
RUN npm prune --omit=dev

ENV NODE_ENV=production
EXPOSE 4100

CMD ["node", "dist/server.js"]
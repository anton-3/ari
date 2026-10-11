# MyFiat - DEMO payments API (controlled security target).
# Multi-stage not needed; better-sqlite3 needs build tools to compile.
FROM node:20-bookworm-slim

# better-sqlite3 compiles a native addon on install.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Seed the database at build time so the container starts with sample data.
RUN npm run seed || true

ENV NODE_ENV=production
ENV PORT=8070
EXPOSE 8070

# Re-seed if empty, then start.
CMD ["sh", "-c", "node seed.js || true; node src/server.js"]

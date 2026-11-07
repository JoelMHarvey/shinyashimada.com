# shinyashimada.com without Netlify: the static site, the functions and the
# daily Trello sync in one Node process (server/server.mjs).
#
#   docker build -t shinyashimada-app .
#   docker run --rm -p 8000:8000 --env-file .env shinyashimada-app
#
# Netlify ignores this file; its deploys are unchanged.
FROM node:22.23.4-bookworm-slim

ENV NODE_ENV=production \
    PORT=8000 \
    HOST=0.0.0.0

WORKDIR /app

# Dependencies first, so a content-only change reuses this layer.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# The site is the repository (Netlify publishes "."), so all of it goes in;
# .dockerignore keeps out git, secrets, tests and local state.
COPY . .

# Local fallback for vocabulary pictures when no S3 bucket is configured.
# Mount a volume here if you rely on it; with S3_BUCKET set it stays empty.
RUN mkdir -p /app/.vocab-images && chown node:node /app/.vocab-images
ENV VOCAB_IMAGE_DIR=/app/.vocab-images

USER node
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/api/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "server/server.mjs"]

# ─── DenchClaw CRM — application image ───────────────────────────────────────
# Runs server/server.js (Express, :3100). The dashboard in web/ is NOT served by
# this process — nginx serves it directly — so it is deliberately not needed at
# runtime here, but bin/ (migrate.mjs et al.) IS, so we copy the whole repo.
FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install production deps against the committed lockfile first, so this layer is
# cached unless package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Drop privileges: the base image ships an unprivileged `node` user.
RUN chown -R node:node /app
USER node

EXPOSE 3100

# Liveness for compose depends_on. /health answers (503) even while the DB probe
# is still retrying, and 200 once the pool is up — so we accept either as "the
# process is alive", and let compose's own retry loop wait for readiness.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "require('http').get('http://127.0.0.1:3100/health',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server/server.js"]

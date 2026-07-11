# NOTE ON THIS IMAGE'S ROLE: real deployments run this app NATIVELY on the
# host under systemd --user, not from this image — see the pivotal
# architecture decision in
# .claude/plans/ok-i-m-thinking-of-merry-corbato.md. Containerizing the
# terminal-bridge process would mean every redeploy kills every live
# session, defeating the whole point. This Dockerfile exists so the
# repo's CI (which builds+pushes an image on every push to main
# regardless) stays green and the image behaves correctly if it's ever
# run standalone — it is not the deploy target for src/services/pty-manager.ts.

# --- Full dependencies (incl. dev) for building ---
FROM node:26-slim AS deps
WORKDIR /app
# Tolerate transient registry hiccups (e.g. ECONNRESET) during install.
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
# node-pty and better-sqlite3 both compile native bindings via node-gyp on
# install — node:26-slim has no build toolchain by default, so `npm ci`
# fails outright without this. Node 26 is recent enough that neither
# package reliably ships a prebuilt binary for it yet, so this is a real
# source build, not a fallback path.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

# --- Build the frontend (frontend/ is its own Vite project, see M3) ---
FROM node:26-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ .
RUN npm run build

# --- Compile TypeScript to dist/ ---
FROM node:26-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- Production-only dependencies ---
FROM node:26-slim AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
# Same reasoning as the deps stage above — `npm ci --omit=dev` still runs
# node-pty/better-sqlite3's install-time native build.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Minimal runtime image ---
FROM node:26-slim AS production
WORKDIR /app
ENV NODE_ENV=production

# dtach is a host apt package, not an npm dependency (see pty-manager.ts) —
# needed at runtime for session persistence if this image is ever actually
# run, even though real deployments install it directly on the host instead.
RUN apt-get update && apt-get install -y --no-install-recommends dtach \
    && rm -rf /var/lib/apt/lists/*

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# Migrations are applied at startup by ensureDb() (resolves ./drizzle).
COPY --from=build /app/drizzle ./drizzle
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Writable data dir for the default SQLite database, owned by the non-root user.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

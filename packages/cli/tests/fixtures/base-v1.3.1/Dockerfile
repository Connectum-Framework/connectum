# The quickstart service, containerised. `engines.node` is >=25.2.0, so TypeScript
# runs directly via native type stripping -- no build step and no flags.
#
# `gen/` is not committed, and `buf` is a devDependency, so code generation happens in
# its own stage with the full dependency tree; the runtime image gets production
# dependencies plus the generated code, and never needs buf.
#
# The Bun variant of this file is Dockerfile.bun. Both are exercised by the
# `example-e2e` workflow in the connectum repository.

# ── build: full dependencies, then generate the proto code ──────────────────
FROM node:25-slim AS build
WORKDIR /app
COPY package.json ./
# No lockfile is committed for this example: deps resolve from the caret (^) ranges in
# package.json, so the image tracks the latest compatible @connectum/* rather than being
# bit-reproducible. That is deliberate for a quickstart -- a production service should
# commit a lockfile and install with `--frozen-lockfile` (the other examples, hris and
# car-sharing included, model this).
RUN npm install --no-audit --no-fund
COPY buf.yaml buf.gen.yaml ./
COPY proto/ ./proto/
RUN npx buf generate

# ── deps: production dependencies only ──────────────────────────────────────
FROM node:25-slim AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:25-slim AS runtime
# curl, not wget: this service serves plaintext h2c (`allowHTTP1: false`), and wget
# speaks HTTP/1.1 only. Against an h2c listener `wget --spider` gets an empty status
# line yet still exits 0, so it would report a dead or NOT_SERVING service as healthy.
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/gen ./gen
COPY package.json ./
COPY src/ ./src/
ENV NODE_ENV=production PORT=5000
EXPOSE 5000
# `-f` fails on a non-2xx status, which is what makes this a health check rather than a
# port check: /healthz answers 200 for SERVING and 503 for NOT_SERVING and UNKNOWN.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD curl -fsS --http2-prior-knowledge http://localhost:${PORT:-5000}/healthz || exit 1
# Run as the built-in non-root `node` user.
USER node
CMD ["node", "src/index.ts"]

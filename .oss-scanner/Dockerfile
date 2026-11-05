# Build environment for the OSS Scanner (https://github.com/anthropics/oss-scanner).
#
# It mirrors the "Typecheck, Lint & Test" job of .github/workflows/ci.yml: Node 26,
# pnpm from the `packageManager` field, a frozen-lockfile install and a full build.
# The scanner uses the repository as the build context and removes network access
# after this build, so everything the audit needs is fetched here: dependencies,
# generated protobuf code and compiled `dist/` output.
FROM node:26-trixie

ENV CI=true \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# Scanner contract: the checkout lives inside the image, at /src.
COPY . /src
WORKDIR /src

# Node 26 no longer bundles corepack, so install the exact pnpm the repository pins.
RUN npm install --global "pnpm@$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")" \
    && pnpm --version

RUN pnpm install --frozen-lockfile

# `build` runs proto generation and the tsup compile for every package; the audit
# needs the compiled `dist/` output.
RUN pnpm build

# Unit tests only. The integration suites start brokers through Docker (NATS, Kafka,
# RabbitMQ) and cannot run here. A failing test must not abort the image build: the
# scanner runs the tests again offline.
RUN pnpm --recursive --if-present run test:unit || echo "WARNING: unit tests reported failures"

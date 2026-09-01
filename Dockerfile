# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /build
COPY host-agent/package.json host-agent/package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY host-agent/tsconfig.json ./
COPY host-agent/src ./src
RUN npm run build

FROM node:22-bookworm-slim

# Tenant shell environment + isolation tooling. Keep this list curated:
# every package is reachable by tenant agents running arbitrary commands.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    iptables \
    jq \
    make \
    g++ \
    procps \
    python3 \
    ripgrep \
    tini \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# dsh is pinned; upgrades go through a new image tag and regression run.
ARG DSH_VERSION=0.1.1-rc.2
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} && npm cache clean --force

# `dsh plugin` execs `pnpm` on PATH. Pin via corepack the same way dsh is
# pinned; upgrades go through a new image tag.
ARG PNPM_VERSION=11.25.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate && pnpm --version

# apemind CLI is baked in (no runtime download): pinned version, pinned
# per-arch sha256, fetched from the public immutable release route.
ARG TARGETARCH
ARG APEMIND_CLI_VERSION=v0.3.3
ARG APEMIND_CLI_SHA256_AMD64=1ae3cddb7ce7e6fdf607537f04886d44dc4ec1c9728b990aa0c4c42edf7174c5
ARG APEMIND_CLI_SHA256_ARM64=0c482cad10b5023994cf510be117db35b92e507a8dddb480100ae9518f468b40
RUN set -eu; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) sha="${APEMIND_CLI_SHA256_AMD64}" ;; \
      arm64) sha="${APEMIND_CLI_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://apemind.ai/api/v2/public/apemind-cli/releases/${APEMIND_CLI_VERSION}/apemind-linux-${arch}" \
      -o /usr/local/bin/apemind; \
    echo "${sha}  /usr/local/bin/apemind" | sha256sum -c -; \
    chmod 0755 /usr/local/bin/apemind; \
    /usr/local/bin/apemind version

ARG COMPUTER_VERSION=dev
ENV COMPUTER_VERSION=${COMPUTER_VERSION} \
    COMPUTER_DATA_DIR=/data

COPY --from=build /build/dist/host-agent.mjs /opt/host-agent/main.mjs

VOLUME /data
EXPOSE 8080 9090

ENTRYPOINT ["tini", "--", "node", "/opt/host-agent/main.mjs"]

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

ARG COMPUTER_VERSION=dev
ENV COMPUTER_VERSION=${COMPUTER_VERSION} \
    COMPUTER_DATA_DIR=/data

COPY --from=build /build/dist/host-agent.mjs /opt/host-agent/main.mjs

VOLUME /data
EXPOSE 8080 9090

ENTRYPOINT ["tini", "--", "node", "/opt/host-agent/main.mjs"]

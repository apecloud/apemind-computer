ARG BASE_IMAGE=ghcr.io/earayu/treadstone-sandbox:v0.2.1
FROM ${BASE_IMAGE}

LABEL org.opencontainers.image.source="https://github.com/apecloud/apemind-computer"
LABEL org.opencontainers.image.description="ApeMind Computer host based on the Treadstone sandbox"
LABEL org.opencontainers.image.base.name="ghcr.io/earayu/treadstone-sandbox:v0.2.1"

# DeepSeek Harness fleet install is a follow-up. This layer only republishes
# the Treadstone sandbox as the ApeMind Computer image.

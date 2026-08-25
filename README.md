# ApeMind Computer

Treadstone sandbox image as the ApeMind Computer host. Later this image will run many long-running DeepSeek Harness agents.

Base image: `ghcr.io/earayu/treadstone-sandbox:v0.2.1`  
Source: [earayu/treadstone](https://github.com/earayu/treadstone)

## Published images

After a tagged release:

- `docker.io/apecloud/apemind-computer:<version>`
- `apecloud-registry.cn-zhangjiakou.cr.aliyuncs.com/apecloud/apemind-computer:<version>`

## Release

1. Push tag `vX.Y.Z`, or run **Release image** and pass `version=vX.Y.Z`.
2. GitHub Actions builds from `Dockerfile` and pushes both registries.
3. Do not build the image on a laptop.

## What is not in this slice

Installing DeepSeek Harness and starting a fleet of agents. That is the next change after CI can publish this base.

## Secrets the workflow needs

Same names as `apecloud/aperag-enterprise`:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`
- `ALIYUN_REGISTRY_USER`
- `ALIYUN_REGISTRY_PASSWORD`

Grant this repository those org/repo secrets and the `[self-hosted, linux, x64, 8c]` runner group, or the publish job cannot run.

# ApeMind Computer

Official Computer image. The sandbox Dockerfile tree lives in this repo under `sandbox-image/` so it can be changed here. It was copied from [earayu/treadstone](https://github.com/earayu/treadstone) `deploy/sandbox-image` (Apache-2.0). Treadstone control plane is not in this repo.

Later this image will run many long-running DeepSeek Harness agents.

## Published images

After a tagged release:

- `docker.io/apecloud/apemind-computer:<version>`
- `apecloud-registry.cn-zhangjiakou.cr.aliyuncs.com/apecloud/apemind-computer:<version>`

## Release

1. Push tag `vX.Y.Z`, or run **Release image** and pass `version=vX.Y.Z`.
2. GitHub Actions builds `sandbox-image/reconstructed` from Ubuntu, then `sandbox-image`, and pushes both registries.
3. Do not build the image on a laptop.

## What is not in this slice

Installing DeepSeek Harness and starting a fleet of agents. That is the next change after CI can publish this base.

## Secrets the workflow needs

Same names as `apecloud/aperag-enterprise`:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`
- `ALIYUN_REGISTRY_USER`
- `ALIYUN_REGISTRY_PASSWORD`

Grant this repository those org/repo secrets, or the publish job cannot run. Image jobs use GitHub-hosted `ubuntu-latest`.

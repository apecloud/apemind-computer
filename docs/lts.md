# LTS

分支名：`lts/0.2`。基线是已发布的 `v0.2.8`。

规则：

1. 不把 `main` 整支合进 `lts/0.2`。只 cherry-pick 已在 main 验证的修复。
2. 不 force-push `lts/0.2`，不改写已发布的 `v0.2.*` tag。
3. 准入默认只收阻塞缺陷、安全和数据正确性；新功能走 main。
4. 切 tag 会触发镜像发布（Docker Hub + 张家口 ACR）。Chart 仍在本仓 `deploy/`；
   进入 `apecloud/helm-charts` 之前，Kubernetes 离线现场使用已打好的 `.tgz`。
5. 产物不等于现场部署。客户环境上线需要单独授权。

离线 Compose / Kubernetes 入口在 `apecloud/apemind-compose-deploy` 和
`apecloud/apemind-k8s-deploy` 的 `deploy/components/computer`，不进入 ApeMind
核心默认安装。

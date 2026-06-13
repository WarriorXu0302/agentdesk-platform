# ADR-0029: 供应链 + 最小权限硬化（pre-commit / digest pin / obs cap_drop / agent no-new-privileges）

- **Status**: Accepted
- **Date**: 2026-06-13
- **Decider(s)**: 用户（WarriorXu，平台 owner）；coding agent（提案 + 执行）
- **Tags**: `security`, `supply-chain`, `container`, `observability`, `ci`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

成熟度审计（MEMORY: platform-maturity-audit-2026-06）与 openclaw 对标清单（⑨
最小权限）共同指出几处低风险但确实存在的供应链 / 权限缺口，且都可以在**不改变
现有运行行为**的前提下补齐：

- **无 pre-commit 防线**：密钥（私钥 / AWS key / 占位密钥）只能在运行期被
  `src/security/known-weak-secrets.ts`（ADR-0025）拦下，没有提交前的防线，一旦
  误 commit 真实凭证就已经进了 git 历史。
- **基础镜像未按 digest pin**：`container/Dockerfile` 用 `FROM node:22-slim`，
  tag 可被上游静默重指到不同内容；ARG（CLAUDE_CODE / BUN / pnpm / vercel）已 pin，
  唯独基础镜像没有。
- **observability compose 无最小权限**：`docker-compose.prod.yml` /
  `docker-compose.sim.yml` 的长期服务（postgres / phoenix / prometheus /
  alertmanager / grafana）没有 `cap_drop` / `no-new-privileges`，也大多没有
  healthcheck。
- **agent 容器无 security-opt**：运行期 `buildContainerArgs` 已经 `USER node` +
  `--user hostUid:hostGid`（非 root），但没有 `no-new-privileges`，也没有任何
  capability 收敛。

**硬约束（本批最高优先级）**：绝不破坏现有运行，尤其是容器内 chromium /
agent-browser / Playwright 的浏览能力。任何"可能在运行期才暴露"的收紧都必须可
配置、默认关。

## Options Considered

**pre-commit 框架**
- **Option A**：引入 Python `pre-commit` 框架 + `detect-secrets`。功能全，但新增
  Python/uv 运行时依赖与一份独立配置生态，违背"零新运行时依赖"。
- **Option B（选中）**：committed git hook（`git-hooks/pre-commit`，bash），
  `core.hooksPath` 指向它；密钥扫描复用 `known-weak-secrets.ts`，format/lint 直接
  调既有 pnpm script。零新依赖，单一信息源。

**agent 容器收紧程度**
- **Option A**：默认 `cap_drop=ALL` + 白名单 `cap_add`。最严，但 chromium /
  网络的真实需求只能 build 后验证，有"上线才炸"的风险，违背硬约束。
- **Option B（选中）**：`no-new-privileges` 默认开（论证为零风险，见下），
  `cap_drop` 做成 `AGENT_DROP_CAPS` 环境变量驱动、**默认不丢**。平台出厂零风险，
  运营者验证后可自行收紧。

**base image pin**
- 直接用 digest pin（`@sha256:...`），保留 `node:22-slim` 注释与刷新方式。唯一
  合理选项，无对立面。

## Decision

> **拍板**：四项纯加固一起落地，全部遵循"默认零行为变化"原则。

1. **committed pre-commit hook**（Option B）：`git-hooks/pre-commit` 对暂存区 diff
   跑 ① 密钥扫描（PEM 私钥头 / `AKIA|ASIA`+16 / 复用 known-weak 占位集）②
   `pnpm format:check` ③ `pnpm lint`，任一失败非 0 阻止提交；干净提交静默通过。
   `pnpm hooks:install` 设 `core.hooksPath=git-hooks`。
2. **Dockerfile digest pin**：`FROM node:22-slim@sha256:e21fc3...b752`，注释保留
   tag 与 `docker buildx imagetools inspect node:22-slim` 刷新方式。
3. **obs compose 最小权限**：两份 compose 的每个长期服务加
   `security_opt: [no-new-privileges:true]` + `cap_drop: [ALL]`；postgres
   (`pg_isready`)、prometheus / alertmanager / grafana（各自 `/-/healthy` /
   `/api/health`，用镜像自带的 busybox `wget` 探针）加 healthcheck；phoenix 无可靠
   探针，省略并注释说明。
4. **agent 容器 `no-new-privileges` + 可配置 cap_drop**：`buildSecurityArgs(env)`
   恒发 `--security-opt=no-new-privileges:true`；`AGENT_DROP_CAPS`（逗号/空格分隔）
   驱动 `--cap-drop=<CAP>`，**默认空 = 不丢任何 cap**。

**为何 `no-new-privileges` 对浏览路径安全**：该 flag 只阻止 `execve` 通过 setuid/
setgid 二进制或文件 capability 获得**新**权限。容器本就以非 root 运行（Dockerfile
`USER node` + 运行期 `--user`），没有可提升的目标；非 root 下的 chromium 不使用其
setuid sandbox helper，而是退回 userns/seccomp sandbox；agent-browser /
Playwright / bun / git / curl / 出站 HTTP 全部以非特权用户跑，均不依赖 setuid 转换。
因此该 flag 对浏览 / 网络零影响，只缩小提权面。

**为何默认不丢 cap**：丢错 capability 可能以"运行期才暴露"的方式破坏浏览或网络，
违反本批硬约束。出厂保留 Docker 默认 cap 集，运营者验证自身工作负载后用
`AGENT_DROP_CAPS` 收紧。

## Consequences

- **Positive**：密钥提交前即被拦截（防线左移）；base image 内容不可被 tag 重指
  静默替换；obs 服务以最小 capability 运行且可探活；agent 容器提权面收窄。全部
  默认行为不变，浏览能力不受影响。
- **Negative**：开发者需在 clone 后跑一次 `pnpm hooks:install`（未跑则无防线，
  但不阻断）。hook 假定 pnpm/node 在 PATH（开发环境必有）。obs healthcheck 依赖
  镜像自带 busybox `wget`，未来换镜像若移除该二进制需同步更新探针。
- **Neutral / Trade-offs**：`cap_drop` 默认不丢是刻意的安全 vs 零风险取舍——若未来
  能在 CI 里 build + 烟测浏览路径，可重审是否把保守的 `cap_drop` 默认开。digest
  需在每次有意 bump base image 时手工刷新（注释已写明刷新命令）。

## Implementation Notes

- 落地文件：
  - `git-hooks/pre-commit`（chmod 755）、`scripts/scan-secrets.ts`（可测纯函数
    `scanForSecrets` + CLI 入口）、`scripts/scan-secrets.test.ts`
  - `package.json`：`hooks:install` script
  - `docs/DEVELOPMENT.md` §2.1：clone 后 `pnpm hooks:install` 说明
  - `container/Dockerfile`：base image digest pin + 注释
  - `infra/observability/docker-compose.prod.yml` / `docker-compose.sim.yml`
  - `src/container-runner.ts`：`buildSecurityArgs`（导出、纯函数），在
    `buildContainerArgs` 的 `--user` 映射附近 push
  - `src/container-runner.test.ts`：`buildSecurityArgs` 断言
- 依赖上游 ADR：ADR-0025（known-weak-secrets，本 ADR 复用其 deny-list 单一信息源）。
- 验收点：
  - `pnpm typecheck` 通过
  - `pnpm exec vitest run src/container-runner.test.ts scripts/scan-secrets.test.ts` 通过
  - `docker compose -f infra/observability/docker-compose.prod.yml config` 与
    `... docker-compose.sim.yml config` 均通过
  - **digest pin 后的真实镜像 build 由编排者验证（慢，未在本会话执行）**
- **hook 手动验证方式**（自动测试只覆盖 `scanForSecrets` 纯函数）：
  ```bash
  pnpm hooks:install
  printf 'KEY=-----BEGIN PRIVATE KEY-----\n' > /tmp/leak && git add -N /tmp/leak  # 仅示例
  # 或：在仓库内 stage 一个含 AKIAIOSFODNN7EXAMPLE / changeme 的改动后 git commit，应被 block
  git commit -m "test"            # 期望非 0、被拦
  git commit -m "test" --no-verify  # 绕过（仅误报时）
  ```

## References

- MEMORY: `platform-maturity-audit-2026-06`（镜像名 / 身份链 / 无 CI 等 16 条）
- MEMORY: `openclaw-benchmark-2026-06`（⑨ 最小权限 / net-policy）
- ADR-0025: known-weak-secrets 运行期 deny-list（本 ADR 复用）
- 分支：`chore/supply-chain-hardening`

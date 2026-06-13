# ADR-0032: 容器 Egress 联网管控（可配置、默认不限制、opt-in 锁定）

- **Status**: Accepted
- **Date**: 2026-06-13
- **Decider(s)**: 用户（WarriorXu，平台 owner）；coding agent（提案 + 执行）
- **Tags**: `security`, `container`, `egress`, `secrets`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

成熟度审计（MEMORY: `platform-maturity-audit-2026-06`）与 openclaw 对标清单（④
net-policy）共同指出：agent 容器有一条真实的密钥外泄路径，且在不破坏现有运行的前提下
可以补上一层关键缓解。

威胁三要素叠加：

1. **agent 容器按设计执行任意代码**（跑工具、装包、起浏览器、写脚本）——功能而非缺陷。
2. **明文 LLM key 进容器 env**：`openai` / `codex` provider 通过 `docker run -e` 注入
   `OPENAI_API_KEY`（`src/providers/openai.ts`）。这是底层 SDK 直连 OpenAI 兼容 Responses
   API 的**硬需求**，SDK 必须读到 key 才能调用——**无法消除**。（`claude` provider 走
   OneCLI 网关代理，容器内只有 `placeholder` token，真 token 在代理换；
   `src/providers/claude.ts`。）
3. **group 目录连同 `container.json` 以只读挂进容器**，其中可能含
   `backendGateway.signingKey`（HMAC 签名密钥）。agent 改不了但**读得到**。

结论：容器内进程能读到 LLM key 和 signingKey，且**默认能向任意外网地址出站**。一旦
prompt 注入 / 供应链投毒让 agent 执行恶意代码，密钥就能被发往任意地址、或拿去刷任意 API，
网络层没有任何阻拦。

由于明文 key 是 SDK 直连的必需品（消除它需要宿主侧凭证/签名代理，属架构级改造，见后续
工作），**egress 管控是当前真正可落地的缓解**：密钥拿不掉，那就锁住它能被发去哪里。

**硬约束（本批最高优先级，与 ADR-0029 一致）**：绝不默认切断 agent 联网。任何收紧必须
可配置、默认关，无配置时行为与历史完全一致（docker 默认 bridge）。`--network` 值必须做
注入校验，绝不把未校验字符串拼进 docker 参数。不弱化身份链 / 三库 / 品牌不硬编码。

## Options Considered

**默认姿态**
- **Option A**：默认接到 egress-proxy / 默认 `none`。最安全，但**违反硬约束**——会在
  运营者没建好代理网络时直接断掉 agent 的浏览/调 API/装包能力，"上线才炸"。
- **Option B（选中）**：默认**不设** `--network`（docker 默认 bridge，不限制），
  per-group `container.json` `network` + 全局 `AGENT_CONTAINER_NETWORK` 双旋钮 opt-in
  锁定。出厂零行为变化，运营者验证后自行收紧。与 ADR-0029（`cap_drop` 默认不丢）同构。

**`--network` 取值校验**
- **Option A**：自由字符串透传。简单，但任意字符串拼进 docker argv 有注入风险
  （前导 `-` 被当 flag、空格/`;`/`$(...)` 等），**不可接受**。
- **Option B（选中）**：allowlist 校验——字面量 `none`/`host`/`bridge` 或匹配 docker
  网络名规则 `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`（与 `container-runtime.ts` 校验容器名同一
  模式）。非法值 `log.warn` 跳过并**回退默认网络**（不 push、不失败 spawn）——既防注入，
  又满足"配错也不断网"。

**密钥本身**
- **Option A**：本批就把 LLM key / signingKey 从容器内挪走（宿主侧签名/凭证代理）。
  从根上消除泄漏面，但是架构级改造，超出本批范围。
- **Option B（选中）**：本批只做 egress 缓解（锁出口），密钥代理化记为后续工作。
  secret 最小化只做"核对 + 文档确认"（见下）。

## Decision

> **拍板**：egress 管控做成可配置、默认不限制、opt-in 锁定（Option B 全线）。

1. **配置面**：`ContainerConfig` 增可选 `network?: string`（per-group，`container.json`），
   `readContainerConfig` 用 `normalizeNetwork` 解析（照现有 `normalize*` 模式）；全局
   `AGENT_CONTAINER_NETWORK` 环境变量（照现有 `AGENT_DROP_CAPS` 模式，读自 `process.env`）。

2. **解析 + 注入**：纯函数 `resolveContainerNetwork(config, env)` 决定有效值——per-group
   `network` > 全局 `AGENT_CONTAINER_NETWORK` > `undefined`（不设 = 默认 bridge）。
   `isValidContainerNetwork` 做 allowlist 校验；非法值 warn + 回退 `undefined`。
   `buildNetworkArgs` 据此产出 `['--network', value]` 或 `[]`。在 `buildContainerArgs`
   里**与 `buildSecurityArgs` / OTEL env 同区、在 image tag 之前** push（`--network` 是
   docker flag，放 image 之后会被当 entrypoint 参数丢掉）。

3. **secret 最小化（核对，无代码改动）**：确认 `OPENAI_API_KEY` 仅在 `openai` / `codex`
   provider 的 group 注入——provider contribution 经 `getProviderContainerConfig(provider)`
   按**单一**有效 provider 解析（`provider-container-registry.ts`），不存在跨 provider
   泛注入；`claude` group 只得到 `ANTHROPIC_AUTH_TOKEN=placeholder`，无真 key。现状已最小，
   仅在本 ADR / `docs/security/container-egress.md` 记录确认，不动代码。宿主侧网关签名/
   凭证代理（消除容器内 signingKey / 真 key）记为后续工作。

4. **egress-proxy 模式为推荐生产姿态**：运营者建一个 docker 网络 + 只放行 allowlist
   目的地的正向代理/防火墙，把需联网的 group 指过去；纯 DB worker 用 `none`。详见
   `docs/security/container-egress.md`。

**为何默认不限制是对的**：agent 的浏览/调 API/装包是核心能力，默认断网等于砸功能；且
运营者的 egress-proxy 网络是其部署专属、平台无法预设。出厂保持 docker 默认 bridge，把
"锁多紧"交给验证过自身工作负载的运营者——与 ADR-0029 同一取舍哲学。

**为何 egress 是真正的缓解**：明文 LLM key 是 SDK 硬需求、无法消除；signingKey 挂载只读
但可读。锁住出口后，即使密钥被恶意代码读到，也**外传不出去 / 调不了 allowlist 外的 API**，
把"密钥可被滥用的范围"从"整个互联网"压到"运营者放行的少数目的地"。这是纵深防御里最贴近
本场景的一层。

## Consequences

- **Positive**：运营者获得一个零风险默认 + 一键收紧的 egress 旋钮；生产用 egress-proxy +
  allowlist 后，泄漏的 LLM key / signingKey 无法外传、无法调任意 API；纯 DB worker 可
  `none` 把出口面归零。`--network` 值经 allowlist 校验，无注入面。默认行为不变，agent
  联网能力不受影响。
- **Negative**：egress 是缓解非消除——容器内密钥仍是明文，能读到它的代码在 allowlist 内
  仍可正常使用它；allowlist 配太宽（含可转发任意流量的目的地）会让缓解失效；运营者需自行
  建/维护 egress-proxy 网络与 allowlist。
- **Neutral / Trade-offs**：默认不限制是刻意的"零风险 vs 默认安全"取舍——若未来能在 CI 里
  build + 烟测 agent 联网路径，可重审是否提供更安全的默认。容器内密钥的根因要等后续的
  宿主侧凭证/签名代理才能消除；在那之前 egress + 网关 HMAC 校验（ADR-0018/0028）共同兜底。

## Implementation Notes

- 落地文件：
  - `src/container-config.ts`：`ContainerConfig.network` 字段 + `normalizeNetwork` +
    `readContainerConfig` 接线
  - `src/container-runner.ts`：`isValidContainerNetwork` / `resolveContainerNetwork` /
    `buildNetworkArgs`（均导出、纯函数），在 `buildContainerArgs` 的 `buildSecurityArgs`
    之后、image tag 之前 push
  - `src/container-runner.test.ts`：默认不 push / per-group / 全局 / per-group 优先 /
    非法值拒绝 / 合法值（none/host/自定义名）/ argv 顺序在 image 之前
  - `docs/security/container-egress.md`：威胁模型 + 配法 + 与 ADR-0029 关系 + 残留风险
  - `docs/PLATFORM.md` §6.2 env 表加 `AGENT_CONTAINER_NETWORK`，§6.3 加 `network`
- 依赖上游 ADR：ADR-0029（同构的默认零风险 / opt-in 收紧哲学；`no-new-privileges` 正交
  互补）、ADR-0018 / ADR-0028（网关 HMAC 校验，egress 缓解后仍是 signingKey 泄漏的第二道闸）。
- 验收点：
  - `pnpm typecheck` 通过
  - `pnpm exec vitest run` 全量通过（含 `src/container-runner.test.ts` 新增 egress 用例）
  - **真实 `docker run --network <egress-proxy>` 的端到端联网验证由运营者在其部署环境完成**
    （需运营者侧的 egress-proxy 网络，未在本会话执行）

## References

- MEMORY: `platform-maturity-audit-2026-06`（成熟度审计，身份链 / net-policy 缺口）
- MEMORY: `openclaw-benchmark-2026-06`（④ net-policy 对标项）
- ADR-0029: 供应链 + 最小权限硬化（`no-new-privileges` + 可配置 `cap_drop`，同构哲学）
- ADR-0018 / ADR-0028: HMAC 签名启用 / 网关契约硬化（signingKey 的第二道闸）
- `docs/security/container-egress.md`：威胁模型与配置指南
- `docs/enterprise-erp-gateway.md`：后端网关契约（signingKey 用途）
- 分支：`feat/container-egress`

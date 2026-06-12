# ADR-0018: HMAC 签名开通路径 + 未签名可观测

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: 用户（平台 owner，提案/拍板），coding agent（提案/执行）
- **Tags**: `erp-gateway`, `security`, `observability`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

后端网关（`backendGateway`）的 HMAC-SHA256 签名实现本身密码学正确：
`container/agent-runner/src/mcp-tools/gateway.ts` 的 `computeGatewaySignature`
对 `<timestamp>.<nonce>.<body>` 做 HMAC，`applySigningHeaders` 在每次网关请求
上挂三个签名 header；header 名默认派生自品牌命名空间，可被
`backendGateway.signingHeaders` 覆盖。`ContainerConfig.signingKey` 字段
（`src/container-config.ts`）也早已存在。

问题不在密码学，而在**开通路径缺失**：

- `scripts/configure-enterprise-gateway.ts` 的 `parseArgs` 只支持
  `--base-url / --folders / --timeout-ms / --header / --memory-mode`，
  没有 `--signing-key`。运营者要开启签名只能手改各 group 的
  `container.json`，容易漏配、易写错、无脱敏习惯。
- 因此**默认部署网关请求是未签名的**。`applySigningHeaders` 在
  `signingKey` 为空时直接 `return`，请求照常发出但不带签名。任何能访问
  `baseUrl` 的实体都能伪造一个"来自平台容器"的请求 —— 平台侧
  `requester.userId` 身份链（ADR-0017）在网关入口处失去了"请求确实来自
  host 预置容器"这一层保证。
- 这是一个**静默**风险：配置看起来正常、调用成功、无任何信号提示运营者
  签名没开。2026-06 全仓成熟度审计将"身份链可伪造"列为确认差距。

约束：
- 不能破坏现网兼容 —— 已有部署升级后若被强制要求签名会直接全线 500。
- 平台核心保持业务无关；签名是网关契约的一部分，逻辑应留在脚本/配置面，
  不能把某个具体后端的 header 规则硬编码进核心。
- 可观测栈只读（CLAUDE.md load-bearing invariant）：检查函数不得改动
  身份链或消息流，只能上报指标 + 告警。
- 不改 `src/metrics.ts`、`src/index.ts`、`src/container-config.ts`
  （字段已存在）。

## Options Considered

- **Option A**:只补脚本 `--signing-key`，不加可观测。优点：改动最小。
  缺点：未配签名仍然静默，运营者无从知道自己处于裸奔状态；只解决了"能开"，
  没解决"知道该开"。
- **Option B**:补脚本 `--signing-key/--signing-headers` + 启动期扫描所有
  配了 `baseUrl` 但缺 `signingKey` 的 group，用 gauge 上报数量、count>0 时
  warn 列名并给出补齐命令。优点:把静默风险变成可观测、可告警的信号，
  且不改变运行时行为（向后兼容）。缺点:多一个启动期文件遍历（成本极低，
  group 数量级很小）。
- **Option C**:启动期对未签名网关 fail-closed（拒绝启动或拒绝该 group 的
  网关调用）。优点:最强保证。缺点:直接破坏现网兼容；且网关常部署在受信
  内网，强制签名会把"纵深防御"误当"唯一防线"，对受信网络是过度约束。驳回。

## Decision

> **拍板**：选 Option B。

1. 给 `configure-enterprise-gateway.ts` 加 `--signing-key <key>`
   （可回落 `GATEWAY_SIGNING_KEY` 环境变量，避免明文进 shell history）与可选
   `--signing-headers timestamp,nonce,signature`（缺省用代码既有的品牌命名
   空间默认 header 名）。写入对应 group `container.json` 的
   `backendGateway.signingKey/signingHeaders`。console 输出对 key 脱敏
   （只显示是否已设置 + 前 4 位 + 长度），绝不打印明文。后续 run 不带
   `--signing-key` 时**保留**已有 key，避免静默从"已签名"降级回"未签名"。
2. 新增只读启动检查 `src/gateway-signing-check.ts`：遍历所有配了
   `baseUrl` 但缺 `signingKey` 的 group，`gatewayUnsignedGroups.set(count)`
   上报（count=0 也 set，便于面板区分"全签名"与"指标从未上报"），
   count>0 时 `log.warn` 列出 group 并提示用脚本补齐。

未签名为何只 warn 不强制：见 Consequences。

## Consequences

- **Positive**:
  - 运营者有了一条干净的开通路径，不再手改 JSON。
  - 未签名从静默风险变为可观测 + 可告警（`gatewayUnsignedGroups` gauge），
    可在 Grafana 上对 `>0` 配告警。
  - 完全向后兼容：现网升级后行为不变，签名仍是 opt-in。
- **Negative**:
  - 启动期多一次 group 目录遍历（成本可忽略）。
  - gauge 只在启动时刷新一次；运行期通过脚本改了配置不会自动反映到
    gauge，需要重启或后续单独接一个定时刷新（暂不做，见下）。
- **Neutral / Trade-offs**:
  - **为何只 warn 不强制**:(a) 向后兼容 —— 强制会让现网升级直接挂；
    (b) 网关可能部署在受信内网，签名是纵深防御的一层而非唯一防线，强制
    签名对受信网络是过度约束。是否强制应由运营者按其网络信任模型自行决定，
    平台只负责让"未签名"这件事可见。
  - **与重放/nonce 的关系**:平台侧**不**存储 nonce、**不**做重放检测。
    签名只证明"请求体未被篡改且来自持有 key 的一方"。防重放（nonce 缓存 +
    时钟偏移窗口）仍**外包给网关**实现，见
    `docs/enterprise-erp-gateway.md` 的 "HMAC request signing" 章节给出的
    参考策略（±5 分钟时钟窗口、10 分钟 nonce LRU）。本 ADR 不改变这一分工。
  - 若未来需要平台侧也做重放防护、或决定对生产环境强制签名，需重审本 ADR。

## Implementation Notes

- 落地文件：
  - `scripts/configure-enterprise-gateway.ts`（新增 `--signing-key /
    --signing-headers` 解析、写入、脱敏输出、env 回落、保留语义）
  - `scripts/configure-enterprise-gateway.test.ts`（解析/写入/脱敏/保留/env
    回落用例）
  - `src/gateway-signing-check.ts`（只读启动扫描，`checkGatewaySigningCoverage`）
  - `src/gateway-signing-check.test.ts`
  - `docs/enterprise-erp-gateway.md`（签名章节补充脚本开通说明）
- 复用 `src/metrics.ts` 中编排者已新增的 `gatewayUnsignedGroups` gauge
  （本 ADR 未改 metrics.ts）。
- **待编排者接线**:`checkGatewaySigningCoverage()` 已导出但尚未在 host
  启动序列调用（`src/index.ts` 不在本任务文件集）。建议在
  `src/index.ts` 的 `main()` 中、`cleanupOrphans()` 之后、
  与 `checkBaseImage()` 镜像预检相邻处调用（约第 84-85 行附近）——
  那里正是"启动期一次性环境/配置健康检查"的自然位置。
- 依赖上游 ADR：ADR-0017（a2a origin 身份链交叉校验）——本 ADR 补的是
  网关入口处"请求确实来自 host 容器"这一层，与 ADR-0017 互补。

## References

- `docs/enterprise-erp-gateway.md` — HMAC request signing / 重放防护分工
- ADR-0017 — a2a origin_user_id 交叉校验（身份信任链）
- `container/agent-runner/src/mcp-tools/gateway.ts` — 签名实现
- 2026-06 全仓成熟度审计（"身份链可伪造"确认差距）

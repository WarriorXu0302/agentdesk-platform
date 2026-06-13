# ADR-0031: 不 fork 主仓的通道扩展加载（运营者自控目录）

- **Status**: Accepted
- **Date**: 2026-06-13
- **Decider(s)**: yingqi2（用户，提案/拍板）；coding agent（执行）
- **Tags**: `channels`, `extensibility`, `open-source`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

成熟度审计 / openclaw 对标点名【关键扩展能力缺口（⑥）】：作为一个开源、业务无关的
平台，第三方要新增一个通道 adapter（Slack / Discord / 自建 IM / …）**目前只能 fork 主仓**——
把模块拷进 `src/channels/`，再在 `src/channels/index.ts` 追加一行 self-registration
import，然后重新构建。这对开源生态是劝退点：

- 每个下游都要维护一个 fork，跟主仓 rebase 是长期负担；
- 平台核心被迫感知具体通道的存在（与 CLAUDE.md「业务/通道特定逻辑不进核心」相悖）；
- 没有一个「把目录放进去就能接入」的零改仓路径。

已知约束（决策时）：

- **向后兼容**：现有部署没有任何「扩展目录」，新机制不得改变它们的行为——没配
  扩展目录 = 现状，零副作用。
- **不弱化既有不变量**：身份信任链、三库单写、品牌不硬编码（CLAUDE.md 的 load-bearing
  invariants）一个都不能动。
- **已有契约门可复用**：ADR-0030 已经把 `assertChannelAdapterContract` 作为「第三方
  adapter 的结构准入门」发布成可复用资产，并在 ADR 里明说 adapter「可外部安装」。本
  ADR 正是兑现那句话的落地。
- **无 `semver` 依赖**：仓里只有 `cron-parser`，没有 `semver`；版本门要么内联极简实现，
  要么新增依赖类别。

## Options Considered

- **Option A**：维持现状（只能 fork / 拷模块 + 改 `index.ts`）。
  优点：零新增表面。缺点：扩展能力缺口不补，开源生态门槛高。工作量零，但不解决问题。

- **Option B**：做一个**公开插件市场**（对标 clawhub）——中心 registry、签名、版本/分级、
  从远端拉取。优点：生态规模化。缺点：信任模型重（签名链、供应链、撤销）、运营成本高、
  与「业务无关的基线平台」定位不符，且把远端代码拉进宿主进程是一条全新的高风险攻击面。
  本次明确**不做**。

- **Option C**：**运营者自控本地目录 + 版本门 + 契约门 + fail-open**。第三方把
  `manifest.json` + entry 模块放进 `EXTENSIONS_DIR`（运营者本机、自己掌控的目录），
  宿主启动时扫描、校验、动态 import、跑契约门，再交给 `initChannelAdapters` 一视同仁地
  setup。信任模型 = **部署级**（往该目录放代码 ≡ 运营者改仓），故**无签名、无 registry、
  无分级**。优点：零改仓接入、复用 ADR-0030 契约门、向后兼容、信任模型简单清晰。
  缺点：不是「装一下就有海量插件」的市场体验；扩展代码以宿主权限运行（与改仓同权）。
  工作量中。

## Decision

> **拍板**：选 Option C。

1. **运营者自控目录**：`EXTENSIONS_DIR`（env，默认解析到 `~/.config/<namespace>/extensions`，
   与 `mount-allowlist.json` / `sender-allowlist.json` 同处运营者配置目录、在 project root
   之外）。目录不存在 → 直接返回空摘要、零副作用（向后兼容）。

2. **最小 manifest**（`src/channels/extension-manifest.ts`）：
   `{ id, kind:'channel', name, channelType, capabilities?, minHostVersion, entry }`。
   parse 函数返回判别式结果（`{ok:true,manifest}` / `{ok:false,reason}`），**字段缺失/类型错
   不抛、返回原因**；`entry` 拒绝绝对路径与 `..` 穿越。这个 parser 零 I/O、零运行时依赖，
   第三方可在自己测试里离线校验 manifest（与契约门同样作为可复用资产）。

3. **版本门**：`minHostVersion` 是一个**极小的 semver range**（exact / `^` / `~` / `>=` / `*`），
   与宿主版本（`package.json` 运行时读取）比对，不满足 → `log.warn` 跳过、**不 import**
   不兼容代码。因仓里无 `semver`，内联一个极简比较器（`src/channels/semver-range.ts`）；
   无法识别的 range 一律按「不满足」处理（fail-closed 进版本门）。**不新增依赖类别**。

4. **契约门复用（与 ADR-0030 的关系）**：动态 import entry 后，entry 在 import 时
   **self-register**（调 `registerChannelAdapter`，与内置 cli/feishu 同模式）；加载器 diff
   registry 找到新注册项，实例化 factory，跑 **ADR-0030 的 `assertChannelAdapterContract`**。
   不合规 → `log.error` + **从 registry 注销**（新增 `unregisterChannelAdapter`）+ 跳过，
   使不合规 adapter **永远到不了 `initChannelAdapters().setup()`**。注意：ADR-0030 把契约门
   定为「软门」（仅测试期校验，不在运行时拒绝**内置** adapter，见其 Option C 驳回）；本 ADR
   只对**外部加载**的扩展在加载期强制契约门——这不改变内置通道的注册容错风格，只是给
   「外来代码」加了一道结构准入闸，与 ADR-0030 的软门定位不冲突。

5. **fail-open**：任一扩展的任一步抛错（坏 manifest / entry import 抛错 / 契约门失败 /
   未注册）都被 try/catch 包住、log + 跳过该扩展，**绝不让一个坏扩展拖垮宿主启动**。
   加载器返回 `{loaded, skipped+reason}` 摘要。

6. **接线**：在 `src/index.ts` 的 `initChannelAdapters` **之前**调 `loadChannelExtensions()`，
   让外部通道先 self-register，从而被 `initChannelAdapters` 一视同仁地 setup（不重复 setup
   内置通道）。

理由（可验证）：契约门有对应单测且复用 ADR-0030 资产；版本门有 `semver-range` 单测；
fail-open 的每条跳过分支（坏 manifest / 不兼容版本 / 契约失败 / import 抛错 / 未注册 /
目录不存在）都有 `extension-loader.test.ts` 覆盖；现有宿主测试保持全绿。

## Consequences

- **Positive**：
  - 第三方**不 fork 主仓**即可接入通道——放进 `EXTENSIONS_DIR` 即可，主仓 `src/channels/`
    不再被迫感知具体通道。
  - 复用 ADR-0030 契约门，外部 adapter 的结构准入从「运行时炸」前移到「加载期拒绝 + 注销」。
  - 向后兼容：没配 `EXTENSIONS_DIR` 的部署零影响。
  - 信任模型简单：部署级，无签名/registry/供应链负担。
- **Negative**：
  - 扩展代码以**宿主进程权限**运行（与运营者改仓同权）。这是 by design 的信任边界，不是
    安全沙箱——`docs/channels/writing-a-channel.md` 与本 ADR 都写明「只放你信任的扩展；
    版本门/契约门是兼容性/结构守卫，不是安全边界」。
  - registry 新增 `unregisterChannelAdapter` / `getRegisteredFactory` 两个公开函数（小幅
    扩大表面），但都是加载器所需的正当运行时访问器，非测试 seam。
- **Neutral / Trade-offs**：
  - **明确不是公开插件市场**（不学 clawhub）：无中心 registry、无签名、无分级。若未来要做
    远端分发/签名/撤销，是全新的信任模型与攻击面，需另起 ADR + 用户批准。
  - 版本门是**极小** semver 子集（`src/channels/semver-range.ts`）；若将来需要复杂 range，
    应换 `semver` 依赖并写 ADR。
  - 外部 entry 解析平台 import（`registerChannelAdapter` 等）的方式是**打包侧选择**
    （`file:` 依赖 / 相对路径 / 路径别名），平台不强制；example 用仓内相对路径以便就地
    type-check/自测，out-of-tree 作者按 README 换 specifier。

## Implementation Notes

- 落地文件：
  - `src/channels/extension-manifest.ts` —— manifest 类型 + `parseChannelExtensionManifest`（不抛）。
  - `src/channels/semver-range.ts` —— 极简 `satisfies`（无 `semver` 依赖）。
  - `src/channels/extension-loader.ts` —— `loadChannelExtensions` / `resolveExtensionsDir` /
    `readHostVersion`。
  - `src/channels/channel-registry.ts` —— 新增 `unregisterChannelAdapter` / `getRegisteredFactory`。
  - `src/index.ts` —— `initChannelAdapters` 前调 `loadChannelExtensions()`（步骤 3a）。
  - `src/channels/index.ts` —— 顶部注释补充「或放进 EXTENSIONS_DIR 不 fork 接入」。
- 文档：`docs/channels/writing-a-channel.md`（如何不 fork 写通道）。
- 示例：`examples/echo-channel/`（manifest + entry + selftest + README）。
- 测试：`src/channels/extension-loader.test.ts`（manifest parse 单测 + 加载器 5 类路径：
  合规加载 / 版本不兼容跳过 / 契约失败注销 / fail-open 坏 manifest+import 抛错 / 目录不存在零影响）。
- 依赖的上游 ADR：ADR-0030（契约门 `assertChannelAdapterContract`）。
- 后续验收点：`pnpm typecheck` + `pnpm exec vitest run` 全绿；新增加载器/manifest 测试通过、
  无回归（保持现有宿主测试全绿）。

## References

- 成熟度审计 / 对标：`MEMORY.md` → platform-maturity-audit-2026-06、openclaw-benchmark-2026-06（对标 ⑥）。
- 契约定义：`src/channels/adapter.ts`（`ChannelAdapter`）；契约门：`src/channels/channel-contract.ts`。
- 关联 ADR：ADR-0030（通道契约一致性测试 —— 契约门资产，本 ADR 在加载期复用）。
- 关联设计：`docs/channels/writing-a-channel.md`、`docs/feishu-channel.md`、`docs/architecture.md`。

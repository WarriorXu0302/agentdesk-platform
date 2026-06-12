# ADR-0025: 配置安全三件套（.env.example + 占位密钥拒绝 + 保守 fail-fast）

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: yingqi2（提出/拍板），coding agent（提案 + 执行）
- **Tags**: `config`, `security`, `startup`, `identity-trust-chain`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

成熟度审计与 openclaw 对标都点名了同一个高性价比缺口：配置面没有安全防线。

- **48 个 env 变量散落在 ~15 个文件里**，没有任何一处权威清单。新部署者只能靠 grep `process.env` 才能拼出"我到底要配什么"，极易漏配。
- **没有 `.env.example`**，`docs/PLATFORM.md §6` 的最小配置片段不完整，也不是机器/人都能依赖的单一来源。
- **没有统一的启动期校验**。env 在各模块里被 piecemeal 读取（`src/config.ts`、`src/channels/feishu.ts`、`src/providers/openai.ts`、`src/metrics.ts`、`src/roster-*.ts` …），没有任何一处确认"这个部署是内部自洽的"。一个半配的飞书（只有 `FEISHU_APP_ID` 没 secret，或 webhook 模式漏了 `FEISHU_ENCRYPT_KEY`）会安静地把每条入站事件验签失败，而不是在启动时就报错。
- **占位密钥会废掉信任链**。HMAC 签名（ADR-0018）、`/metrics` 鉴权、OneCLI、飞书回调验签都只和喂进去的密钥一样强。最常见的失效方式是：拷了示例配置、占位串 `changeme` / `your-…` 原样上线——它"能跑"，但部署是可伪造的。

触发点：这是 openclaw 对标清单里标注的"最高性价比项"。openclaw 已有 `src/gateway/known-weak-gateway-secrets.ts: assertGatewayAuthNotKnownWeak` 这一防线，本仓缺。

已知约束：

- **不能误伤现有部署**。仓里已有 489 个 host 测试和跑通的最小部署（CLI-only / claude-only / 飞书 long-connection）。任何新校验如果对"没启用某功能"的部署也生效，就会把现成的部署拦在启动门外——这是不可接受的回归。
- 现有 env 读取风格是 `readEnvFile`（解析 `.env`，**不**注入 `process.env`，以免密钥泄漏给子进程）+ `process.env` 兜底。新代码必须沿用，不能改成"全量 dotenv.config()"。
- 活跃 provider 是**按 session 解析的**（`sessions → agent_group → container.json → 'claude'`，见 `resolveProviderName`），没有顶层 `PROVIDER` env，所以无法在启动期静态读出"当前 provider 是不是 openai"。

## Options Considered

- **Option A：只加 `.env.example`（纯文档）**。优点：零行为风险、工作量最小。缺点：解决不了"占位密钥上线"和"半配静默失败"——这俩才是真正会废掉信任链的。
- **Option B：严格 schema 校验（如 zod/envalid 把全部 48 个变量声明为 schema，缺失即 fail）**。优点：最彻底。缺点：几乎必然误伤现有部署——很多变量是"缺了也能降级"的，一刀切 required 会把跑通的最小部署拦下；且引入新依赖类别。与"不可回归"约束冲突。
- **Option C：三件套——权威 `.env.example` + 占位密钥拒绝 + 功能内一致性 fail-fast（保守）**。优点：同时关掉三个缺口；fail-fast 只在"功能被启用"时才要求其必填项，占位密钥只在"已设置且命中已知弱值"时才拒，对没用到该功能的部署零影响。缺点：弱值名单需要和 `.env.example` 占位串手工保持同源（已在两边注释里互指）。

## Decision

> **拍板**：选 Option C。

理由（可验证）：

1. **权威清单**：仓库根 `.env.example` 成为 env 的唯一权威文档，按功能分组，每个变量带必填性/默认值/安全后果；密钥类用显眼占位串。`docs/PLATFORM.md §6` 加一行指向它。
2. **占位密钥防线**：`src/security/known-weak-secrets.ts` 导出 `KNOWN_WEAK_SECRET_PLACEHOLDERS`（收录 `.env.example` 全部密钥占位串 + 常见弱值 `changeme/secret/password/test/xxx/your-*-here` 等）与 `assertSecretNotKnownWeak(name, value)`，命中即抛带变量名 + `openssl rand -hex 32` 提示的错误。规范化（trim + 小写）后匹配，并用 pattern 兜住 `your-*-here` / `replace-me-*` 形状。思路对标 openclaw `assertGatewayAuthNotKnownWeak`。
3. **保守 fail-fast**：`src/config-validate.ts: validateStartupConfig()` 做**功能内一致性**校验——只在某功能被启用时才要求其必填项：① 飞书 webhook/hybrid 模式才要求 `FEISHU_ENCRYPT_KEY` + `FEISHU_VERIFICATION_TOKEN`；② 配了 `FEISHU_APP_ID`/`FEISHU_APP_SECRET` 之一就要求另一半；③ 任一 `OPENAI_*` 配置项被设置（=意图用 openai provider）却没 `OPENAI_API_KEY` 才 fail。其余"缺了也能降级"的（如 `METRICS_AUTH_TOKEN` 未设 → `/metrics` 公开）只 `log.warn`。known-weak 校验并入此函数统一调用，只对"已设置且非空"的安全关键密钥生效。

保守取舍一句话：**只在功能启用时才必填、只对已设置的密钥才拒占位**——没用到的功能与未设置的可选项一律不 fail，确保现有跑通的最小部署不被拦下。

接入点：`src/index.ts` 启动序列 `cleanupOrphans()` 之后、建连接（`initChannelAdapters`）之前，与既有的 `checkBaseImage()` / `checkGatewaySigningCoverage()` 同段。

## Consequences

- **Positive**：信任链的成立从"运行期被审计发现"前移到"部署期 fail-fast"；新部署者有了单一权威清单，48 变量黑洞收口；占位密钥上线变成硬启动错误而非静默漏洞。
- **Negative**：弱值名单要和 `.env.example` 占位串手工同源（两边注释已互指）；`validateStartupConfig` 是新的启动期 throw 点——必须保证它只在功能启用时 throw，否则会变成回归源（已用测试钉死最小部署/long-connection 不被拦）。
- **Neutral / Trade-offs**：不是熵检测器——刻意选的真随机短密钥也放行，只拦已知占位/弱值。openai provider 的必填判定用"任一 OPENAI_* 被设置"作为启用信号（因为 provider 是按 session 解析的，启动期读不到单一 provider 名）；若将来引入顶层 provider 选择 env，应改用它作为更精确的信号并重审本条。`ERP_GATEWAY_BASE_URL` 经核查为 erp→gateway 泛化的遗留**别名**，仍被 `scripts/configure-enterprise-gateway.ts` 作为 `GATEWAY_BASE_URL` 的 fallback 读取（非 dead），本批不删代码，仅在 `.env.example` 注释标注"优先用 `GATEWAY_BASE_URL`，此为废弃别名"。

## Implementation Notes

- 落地文件：
  - `/.env.example`（新增，权威清单）
  - `src/security/known-weak-secrets.ts`（新增）+ `src/security/known-weak-secrets.test.ts`
  - `src/config-validate.ts`（新增）+ `src/config-validate.test.ts`
  - `src/index.ts`（接入 `validateStartupConfig()`，2b 步）
  - `docs/PLATFORM.md §6`（加指向 `.env.example` 的一行）
- 依赖的上游 ADR：ADR-0018（HMAC 签名 opt-in，本防线保护的对象）、ADR-0019（fail-closed 安全默认，同源思路）。
- 验收点：占位密钥被拒、真随机值通过、未设置的可选密钥不被 fail；webhook 模式缺 encrypt key 被 fail、long-connection / 最小 CLI 部署不被任何新校验拦；app id/secret 配对校验。现有 489 host 测试保持全绿。

## References

- openclaw `src/gateway/known-weak-gateway-secrets.ts`（`assertGatewayAuthNotKnownWeak` 思路来源）
- 用户记忆：`openclaw 对标吸取清单`（契约硬化条目）、`全仓成熟度审计`（48 env 散落 / 无 .env.example / 占位密钥废信任链）
- 相关代码：`src/env.ts`（readEnvFile）、`src/gateway-signing-check.ts`（启动期检查风格参考）、`src/container-runner.ts: resolveProviderName`（provider 按 session 解析）

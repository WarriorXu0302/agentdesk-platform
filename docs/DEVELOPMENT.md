# AgentDesk Development — 开发者上手指南

面向新加入的开发者。读完应该知道：代码在哪、加新功能从哪下手、本地怎么调、写测试有什么坑。

预设：已经读过 [PLATFORM.md](PLATFORM.md) 顶层概览。

---

## 1. 代码 layout（按职责分）

```
src/                                        Host 侧（Node + pnpm）
├── index.ts                                进程入口：DB init / migrations / 通道 / 投递循环 / sweep
├── router.ts                               入站路由：messaging_group → session → 写 inbound.db
├── delivery.ts                             出站投递：轮询 outbound.db → adapter / system action
├── host-sweep.ts                           60s 全局清扫：心跳、stuck 检测、TTL 归档、due-message 唤醒
├── session-manager.ts                      session resolve、heartbeat 路径、DB 句柄
├── container-runner.ts                     spawn / wake / kill 容器，挂载、cgroup 限制
├── container-runtime.ts                    Docker vs Apple container 选择
├── command-gate.ts                         Router 层管理员命令门
├── enterprise-autowire.ts                  企业入口自动接线策略
├── reconcile-classification.ts             分类协议闭环（在 delivery.ts 里 export 出来）
│
├── channels/                               通道适配器
│   ├── adapter.ts                          IChannelAdapter 接口
│   ├── channel-registry.ts                 注册表
│   ├── ask-question.ts                     卡片询问统一封装
│   ├── feishu.ts / feishu/                 飞书适配器
│   ├── cli.ts                              本地调试用
│   └── chat-sdk-bridge.ts                  Web Chat SDK 桥
│
├── modules/                                平台模块（横切关注点）
│   ├── agent-to-agent/                     a2a 派活、origin_user_id 跨 hop
│   ├── approvals/                          OneCLI 凭证审批桥
│   ├── classification-log/                 分类决策审计
│   ├── gateway-audit/                      后端网关调用审计
│   ├── interactive/                        卡片回调、交互组件
│   ├── mount-security/                     容器挂载安全检查
│   ├── permissions/                        owner / admin / member 权限解析
│   ├── progress-status/                    "处理中" reaction 提示
│   ├── provider-errors/                    LLM 错误分类入指标
│   ├── scheduling/                         定时任务、recurrence
│   ├── self-mod/                           self-modification 应用
│   └── typing/                             "正在输入" indicator
│
├── db/                                     中央 DB 访问层
│   ├── index.ts                            DB 句柄、事务、test 工厂
│   ├── migrations/                         001 ~ 024 顺序迁移
│   ├── classification-log.ts               recordClassification / linkOutcome
│   ├── gateway-audit.ts                    record + query
│   ├── sessions.ts / agent_groups.ts / ...
│
└── metrics.ts                              Prometheus 指标暴露 + /metrics

container/agent-runner/                     容器侧（Bun，独立 package tree）
├── src/
│   ├── poll-loop.ts                        每 1s 轮询 inbound.db，调 provider，写 outbound.db
│   ├── formatter.ts                        消息格式化、extractRouting
│   ├── current-batch.ts                    per-turn 状态：inReplyTo / classificationId
│   ├── request-context.ts                  RequestIdentity 单例
│   ├── request-identity.ts                 splitBatchByTurn / rowIdentity
│   ├── a2a-origin.ts                       共享 origin_user_id 解析
│   ├── providers/                          claude / openai / mock
│   ├── mcp-tools/                          内置 MCP 工具
│   │   ├── core.ts                         send_message / send_file / ask_user_question
│   │   ├── classify-intent.ts              分类协议 entry point
│   │   ├── gateway.ts                       后端网关 5 个工具
│   │   ├── scheduling.ts                   schedule_task / list_tasks
│   │   ├── interactive.ts                  卡片
│   │   ├── self-mod.ts                     install_packages / add_mcp_server
│   │   └── agents.ts                       a2a 友好包装
│   ├── db/                                 inbound.db / outbound.db schema
│   └── ...
└── tsconfig.json                           独立 typecheck 入口

groups/<folder>/                            每个 agent_group 的根
├── CLAUDE.md                               该 group 的 system prompt
├── container.json                          资源 + 后端网关配置
├── skills/                                 group 私有 skill
└── agent-runner-src/                       per-group runtime overlay（罕用）
```

---

## 2. 开发循环

### 2.1 第一次 setup

```bash
git clone <repo> && cd agentdesk-platform

# Host 依赖
pnpm install --frozen-lockfile

# 容器依赖（独立的）
cd container/agent-runner && bun install && cd ../..

# 容器镜像
./container/build.sh

# 跑一次 init
pnpm exec tsx scripts/init-enterprise-topology.ts

# 装 git pre-commit 钩子（密钥扫描 + format:check + lint，ADR-0029）
pnpm hooks:install
```

> `pnpm hooks:install` 把 `core.hooksPath` 指到仓库内的 `git-hooks/`（committed
> 钩子，无 Python pre-commit 依赖）。每次 clone 后跑一次。钩子在暂存区命中私钥 /
> AWS key / 已知占位密钥（复用 `src/security/known-weak-secrets.ts`）、prettier 或
> eslint 失败时阻止提交；干净提交时静默通过。误报可用 `git commit --no-verify` 临时绕过。

### 2.2 改 host 代码

```bash
# Hot reload
pnpm run dev

# Typecheck
pnpm typecheck

# 测试
pnpm test
pnpm test path/to/file.test.ts
pnpm test -t "test name"
```

### 2.3 改容器代码

容器代码用 **Bun**，不是 Node。`vitest` 不能用，必须 `bun:test`。

```bash
# 容器侧 typecheck
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit

# 容器侧测试（在 container/agent-runner/ 下）
cd container/agent-runner && bun test

# 没装 bun？用 docker
docker run --rm -v "$(pwd)/container/agent-runner":/app -w /app oven/bun:1 bun test

# 改了容器代码后必须重建镜像
./container/build.sh
```

⚠️ **buildkit 缓存陷阱**：`--no-cache` 不一定生效，COPY 步骤可能用旧文件。彻底重建：
```bash
docker buildx prune -af
./container/build.sh
```

### 2.4 改 DB schema

```bash
# 1. 写新 migration（编号顺延）
touch src/db/migrations/025-my-feature.ts

# 2. 必须 idempotent
cat > src/db/migrations/025-my-feature.ts <<'TS'
import type { Database } from 'better-sqlite3';

export const migration025 = {
  id: '025-my-feature',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS my_table (
        id TEXT PRIMARY KEY,
        ...
      );
    `);
  },
};
TS

# 3. 注册到 migrations index（src/db/migrations/index.ts）

# 4. 启动 host 自动跑（或手动）
pnpm exec tsx scripts/run-migrations.ts

# 5. ALTER TABLE ADD COLUMN 的 idempotent 写法见 022 / 024
```

DDL 规则：
- 永远 `IF NOT EXISTS`
- 永远向前（不写 down）
- ADD COLUMN 必须有默认值或 NULL 可接受
- 不要 RENAME / DROP（现网数据丢了）

---

## 3. 加一个新通道（adapter）

参考 `src/channels/feishu.ts`。一个 channel adapter 必须实现：

```ts
interface IChannelAdapter {
  type: string;                              // 'slack' | 'discord' | ...
  resolveSender(event): Promise<UserId>;    // 平台用户 → users 表 id
  deliver(message, target): Promise<void>;  // 把 outbound 发出去
  // 可选: ack(message)、reaction()、card render 等
}
```

最少步骤：

```bash
# 1. 新文件
touch src/channels/slack.ts

# 2. 注册
# 在 src/channels/index.ts 里 import + register

# 3. 测试
touch src/channels/slack.test.ts
```

依赖第三方 SDK 时：
```bash
pnpm add @slack/web-api
# 注意 minimumReleaseAge=4320，新版本要等 3 天
```

不要硬编码到主仓库——AgentDesk 的设计是 `channels` branch 装 skill 拉，但企业内部使用直接 commit 到 src 也可以。

---

## 4. 加一个新 worker（agent_group）

```bash
# 1. 在 init script 里加一行
# scripts/init-enterprise-topology.ts
const workers = [
  ...,
  { folder: 'agentdesk-hr-worker', displayName: 'HR Worker' },
];

# 2. 加 frontdesk 派活 destination
# 同一个脚本里 ensureDestination(...)

# 3. 跑
pnpm init:enterprise

# 4. 编辑 group 的 CLAUDE.md 写 system prompt
vim groups/agentdesk-hr-worker/CLAUDE.md

# 5. 配资源
vim groups/agentdesk-hr-worker/container.json
```

**Worker 的 system prompt 要点**：
- 明确这个 worker 负责什么、不负责什么
- 不需要再讲 `classify_intent`（那是 frontdesk 的事）
- 直接讲业务约束（哪些后端 operation 可以调、什么时候要 dryRun）

---

## 5. 加一个新 MCP 工具（容器侧）

参考 `container/agent-runner/src/mcp-tools/scheduling.ts`。

```ts
// container/agent-runner/src/mcp-tools/my-tool.ts
import type { McpTool } from './types.js';

export const myTool: McpTool = {
  name: 'my_tool',
  description: '...',
  inputSchema: {
    type: 'object',
    properties: { ... },
    required: ['...'],
  },
  async handler(args) {
    // 1. 读身份（不要信 args 里的 userId）
    const identity = getRequestIdentity();

    // 2. 业务逻辑

    // 3. 写 outbound（如果要让 host 做事）
    appendOutbound({
      kind: 'system',
      action: 'my_action',
      content: { ... },
    });

    return { ok: true, ... };
  },
};

// 注册到 container/agent-runner/src/mcp-tools/index.ts
```

如果工具需要 host 配合（写 audit、调外部服务），用 **delivery action 模式**：

```ts
// container 侧 emit
appendOutbound({ kind: 'system', action: 'my_audit', content: { ... } });

// host 侧 src/index.ts 启动时注册 handler
import { registerDeliveryAction } from './delivery.js';
registerDeliveryAction('my_audit', async (msg, ctx) => {
  await db.prepare('INSERT INTO my_audit ...').run(...);
});
```

参考已有的：`gateway_audit` / `classify_intent` / `provider_error` / `schedule_task` 都是这个模式。

写测试：
```bash
container/agent-runner/src/mcp-tools/my-tool.test.ts   # bun:test
src/my-action.test.ts                                  # vitest
```

---

## 6. 测试规约

### 6.1 两套 runtime

| 位置 | runner | 框架 |
|---|---|---|
| `src/*.test.ts` | Node + vitest | `import { describe, it, expect } from 'vitest'` |
| `container/agent-runner/src/*.test.ts` | Bun + bun:test | `import { ... } from 'bun:test'` |

跨边界跑会失败：vitest 不能 load `bun:sqlite`，bun:test 不认 vitest mocks。

### 6.2 DB 测试

```ts
// Host
import { initTestDb, closeDb, runMigrations } from './db/index.js';
beforeEach(() => { runMigrations(initTestDb()); });
afterEach(() => closeDb());

// Container
import { initTestSessionDb, closeSessionDb } from './db/connection.js';
beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());
```

每个测试一个干净的 in-memory DB。不要 share state。

### 6.3 写测试该测什么

- **不变式**：身份不漂、outcome_ref first-write-wins、批拆分后 anchor 正确
- **边界**：空批、纯非 chat 行、跨 session 引用、未知 surface
- **回归**：reviewer 指出的具体场景（test 名字直接抄 reviewer 描述）

参考已有：
- `container/agent-runner/src/turn-routing.test.ts` — 路由 anchor
- `container/agent-runner/src/mcp-tools/core.test.ts` — origin_user_id / classificationId
- `src/reconcile-classification.test.ts` — 分类协议闭环

---

## 7. 关键不变式（改代码前必须知道）

1. **三 DB 单写者**
   - `data/v2.db`：只 host 写
   - `<session>/inbound.db`：只 host 写
   - `<session>/outbound.db`：只容器写
   - 跨虚拟化挂载 WAL 不可靠 → 全部 `journal_mode=DELETE`，open-write-close

2. **身份从不信 agent**
   - tool handler 用 `getRequestIdentity()` 读，不读 `args.userId`
   - frontdesk 派活时，host 从 session 派生 origin_user_id，不从 agent emit 的字段读

3. **Migration idempotent + 不可逆**
   - `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`
   - 永不 DROP / RENAME 已上线列

4. **Seq 奇偶**
   - inbound.db: host 写 even seq
   - outbound.db: container 写 odd seq
   - 跨边界协调全靠这个，不要手算

5. **Classify before delegate**
   - 容器侧：`send_message` 到 agent destination 必须有 `_classificationId`（除非 fallback 是 channel）
   - host 侧：`reconcileClassification` 是 fail-open（observability，不阻断）

6. **Delivery action 是约定**
   - 容器要 host 做事 → emit `kind='system', action='X'` 的 outbound
   - host → `registerDeliveryAction('X', handler)` 接住

---

## 8. Code Review checklist

提 PR 前自查：

- [ ] 涉及身份的代码：用 RequestIdentity，不读 agent 自报字段
- [ ] 新增 outbound：明确是 chat / agent / system 哪种 kind
- [ ] 新增 system action：注册了 handler，写了 audit（如果是敏感操作）
- [ ] DB schema 改动：写了 migration，编号顺延，idempotent
- [ ] 容器 SQL：用 `$name` 占位（`bun:sqlite` 不剥前缀）
- [ ] 测试覆盖：normal / empty / cross-session / mixed-batch
- [ ] Metric 命名：`<namespace>_<noun>_<unit>`（默认 `agentdesk_`），labels 不爆基数（< 50）
- [ ] 没引入 setTimeout / setInterval（用 host-sweep 的 60s tick）
- [ ] 没绕开 MAX_CONCURRENT_CONTAINERS

---

## 9. 常见坑

### 9.1 容器里 SQL 报 "missing parameter"

`bun:sqlite` 跟 host 的 `better-sqlite3` 不一样。

```ts
// ✅ 正确
db.prepare('INSERT INTO t (id) VALUES ($id)').run({ $id: 'x' });

// ❌ 错（bun 不会自动剥 :id 前缀）
db.prepare('INSERT INTO t (id) VALUES (:id)').run({ id: 'x' });

// ✅ 位置参数也行
db.prepare('INSERT INTO t (id) VALUES (?)').run('x');
```

### 9.2 容器改了但行为没变

镜像没重建。`./container/build.sh`。

### 9.3 host-sweep 没起作用

```bash
# 看 sweep tick 日志
grep "sweep" logs/agentdesk.log | tail
```

如果完全没 tick：检查 `src/index.ts` 是不是注册了 `host-sweep`。

### 9.4 测试在本地通过但 CI 挂

通常是：
- 用了 `Date.now()` 没 mock
- 用了文件系统但没用 tmp dir
- 用了真实 docker 但 CI 没 docker

### 9.5 修改 `pnpm-workspace.yaml` 加包

`minimumReleaseAge: 4320` 卡 3 天。如果是急用：
- 不要往 `minimumReleaseAgeExclude` 加，需要人审批
- 找一个 3 天前的版本

---

## 10. 文档贡献

| 改这个 | 写这里 |
|---|---|
| 平台高层概览 / 架构图 | `docs/PLATFORM.md` |
| 边界 / 不做什么 | `docs/SPEC.md` |
| 详细架构 | `docs/architecture.md` |
| DB schema | `docs/db-central.md` / `docs/db-session.md` |
| 通道协议 | `docs/api-details.md` |
| 容器内部 | `docs/agent-runner-details.md` |
| 运维 | `docs/RUNBOOK.md` |
| 开发上手 | `docs/DEVELOPMENT.md`（本文件） |
| 后端集成 | `docs/ERP-INTEGRATION-GUIDE.md` |

文档原则：
- 单一信息源（不要在两个文档里讲同一件事，互相 link）
- 给代码示例和真实文件路径
- 时效性的内容（环境变量、metric 名）跟代码常量绑死，改一处对不上立刻发现

---

## 11. 进一步阅读

- [PLATFORM.md](PLATFORM.md) — 顶层导航
- [architecture.md](architecture.md) — 详细 message flow
- [agent-runner-details.md](agent-runner-details.md) — poll-loop 内部
- [build-and-runtime.md](build-and-runtime.md) — 双 runtime / lockfile / 镜像
- [enterprise-erp-gateway.md](enterprise-erp-gateway.md) — 后端网关协议
- [RUNBOOK.md](RUNBOOK.md) — 线上故障处置

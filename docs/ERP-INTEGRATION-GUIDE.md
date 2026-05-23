# ERP Integration Guide — 后端开发者教程

面向负责实现 ERP gateway 后端的开发者。读完应该能从零搭出一个跟 FrontLane 对接的最小可用网关，并知道怎么扩展到生产规模。

预设：已经读过 [enterprise-erp-gateway.md](enterprise-erp-gateway.md) 的协议定义。本文是"怎么实现"，不是"协议是什么"。

---

## 1. 你的网关在干什么

```
FrontLane container
   ↓ HTTP POST + (可选) HMAC 签名
你的 ERP gateway              ← 你要写的就是这个
   ↓ 内部 RPC / SQL / SOAP
ERP / SSO / 审批 / 数据库
```

网关的责任清单（按重要性）：

1. **身份映射**：FrontLane 给你 `feishu:ou_xxx`，你查出对应的 ERP 员工号
2. **权限判断**：这个员工有没有权限做这个操作
3. **签名校验**（如果开了 HMAC）：拒绝伪造 / 重放
4. **幂等性**：`idempotencyKey` 一致的请求只执行一次
5. **审批集成**：高风险操作走你们的审批流，gateway 等审批结果再返回
6. **业务执行**：实际调 ERP
7. **审计**：你方的审计日志（FrontLane 也有 `erp_audit`，互为参照）
8. **memory 读写**：用户偏好、业务摘要的持久化

FrontLane **不**做：用户表、权限表、审批表、业务数据。这些都在你这边。

---

## 2. 30 分钟搭出最小可用版本

最简实现：Node + Express + 内存存储。生产替换为你们栈即可。

```ts
// gateway.ts
import express from 'express';

const app = express();
app.use(express.json({ limit: '1mb' }));

interface RequestEnvelope {
  agent: { agentGroupId: string; groupName: string; assistantName: string };
  requester: {
    userId: string;
    channelType: string | null;
    platformId: string | null;
    threadId: string | null;
  };
  requesterSource: 'session' | 'agent-asserted';
  operation: string;
  input: Record<string, unknown>;
  context: Record<string, unknown>;
  dryRun: boolean;
  idempotencyKey: string | null;
}

// === 1. describe：告诉 agent 你支持什么操作 ===
app.post('/describe', (req, res) => {
  res.json({
    operations: [
      {
        name: 'sales.order.lookup',
        summary: '查询销售订单',
        input: { orderId: { type: 'string', required: true } },
        readOnly: true,
      },
      {
        name: 'sales.order.create',
        summary: '创建销售订单',
        input: {
          customerId: { type: 'string', required: true },
          items: { type: 'array', required: true },
        },
        readOnly: false,
        requiresApproval: true,
      },
    ],
  });
});

// === 2. authorize：操作前置鉴权 ===
app.post('/authorize', async (req, res) => {
  const env = req.body as RequestEnvelope;
  const erpUser = await mapToErpUser(env.requester.userId);
  if (!erpUser) return res.json({ allowed: false, reason: 'user_not_mapped' });

  const allowed = await checkPermission(erpUser, env.operation);
  if (!allowed) return res.json({ allowed: false, reason: 'forbidden' });

  // agent-asserted 的写操作直接拒
  if (env.requesterSource === 'agent-asserted' && !isReadOnly(env.operation)) {
    return res.json({ allowed: false, reason: 'untrusted_identity' });
  }

  res.json({ allowed: true });
});

// === 3. execute：实际执行 ===
app.post('/execute', async (req, res) => {
  const env = req.body as RequestEnvelope;
  const erpUser = await mapToErpUser(env.requester.userId);
  if (!erpUser) return res.status(403).json({ error: 'user_not_mapped' });

  // 幂等
  if (env.idempotencyKey) {
    const cached = await getIdempotent(env.idempotencyKey);
    if (cached) return res.json(cached);
  }

  // dryRun
  if (env.dryRun) {
    return res.json({ ok: true, dryRun: true, preview: { ... } });
  }

  // 审批
  if (needsApproval(env.operation)) {
    const approval = await requestApproval(erpUser, env);
    if (approval.status !== 'approved') {
      return res.json({ ok: false, error: 'approval_denied', approvalId: approval.id });
    }
  }

  // 调 ERP
  const result = await callErp(erpUser, env.operation, env.input);

  if (env.idempotencyKey) await saveIdempotent(env.idempotencyKey, result);
  res.json({ ok: true, result });
});

// === 4. memory ===
app.post('/memory/get', async (req, res) => {
  const { requester, key, namespace } = req.body;
  const value = await memoryStore.get(requester.userId, namespace, key);
  res.json({ value });
});

app.post('/memory/upsert', async (req, res) => {
  const { requester, key, namespace, value } = req.body;
  await memoryStore.upsert(requester.userId, namespace, key, value);
  res.json({ ok: true });
});

app.listen(3001, () => console.log('ERP gateway on :3001'));
```

跑起来后在 FrontLane 配：

```bash
pnpm configure:enterprise-gateway --base-url http://localhost:3001
```

然后让 frontdesk 发"帮我查订单 INV-001"，看 `data/v2.db` 的 `erp_audit`。

---

## 3. 身份映射 (`mapToErpUser`)

最常见的实现路径：

```
feishu:ou_xxx
   ↓ 飞书开放平台 user_info API（用 ou_xxx 拿员工的 mobile 或 email）
mobile / email
   ↓ AD / SSO 反查 ERP 员工号
ERP user_id
```

要点：
- 缓存映射表（`ou_xxx → erp_user_id`），变化的话靠 webhook 或定时同步
- 没映射上 → 拒绝（`requesterSource='session'` 是平台保证，但用户不在 ERP 里也得拒）
- 离职员工：从映射表删掉，下次请求自然拒绝

```ts
async function mapToErpUser(frontlaneUserId: string): Promise<ErpUser | null> {
  // 'feishu:ou_xxx' → 'ou_xxx'
  const [channel, handle] = frontlaneUserId.split(':');

  // 1. 查映射表
  const cached = await db.query(
    'SELECT erp_user_id FROM identity_map WHERE channel=? AND handle=?',
    [channel, handle],
  );
  if (cached) return loadErpUser(cached.erp_user_id);

  // 2. 反查飞书 → 找邮箱 → 找 ERP
  if (channel === 'feishu') {
    const profile = await feishu.users.get(handle);
    const erp = await erpDb.query('SELECT * FROM users WHERE email=?', [profile.email]);
    if (erp) {
      await db.query('INSERT OR REPLACE INTO identity_map ...');
      return erp;
    }
  }

  return null;
}
```

---

## 4. 权限判断 (`checkPermission`)

不要让 agent 决定什么能做、什么不能做（prompt 可以注入）。

| 操作类型 | 谁批 |
|---|---|
| 读自己的数据 | 自动允许 |
| 读他人 / 全局数据 | RBAC（员工角色 → 可读范围） |
| 写自己的数据 | RBAC + 操作白名单 |
| 写他人 / 财务 / 审批 | 必走审批流 |

最小实现：操作 → 所需角色映射表。

```ts
const operationPolicy: Record<string, { roles: string[]; needsApproval: boolean }> = {
  'sales.order.lookup': { roles: ['sales', 'manager'], needsApproval: false },
  'sales.order.create': { roles: ['sales', 'manager'], needsApproval: true },
  'finance.invoice.approve': { roles: ['finance_manager'], needsApproval: true },
};

async function checkPermission(user: ErpUser, op: string): Promise<boolean> {
  const policy = operationPolicy[op];
  if (!policy) return false;  // 默认拒绝未知操作
  return user.roles.some((r) => policy.roles.includes(r));
}
```

---

## 5. 幂等性

每次 `execute` 必须看 `idempotencyKey`。容器侧 retry / host 重投递都会带同一个 key。

```ts
// 简易实现
async function getIdempotent(key: string): Promise<unknown | null> {
  const row = await db.query(
    'SELECT response FROM idempotency WHERE key=? AND expires_at > NOW()',
    [key],
  );
  return row ? JSON.parse(row.response) : null;
}

async function saveIdempotent(key: string, response: unknown): Promise<void> {
  await db.query(
    'INSERT INTO idempotency (key, response, expires_at) VALUES (?, ?, NOW() + INTERVAL 24 HOUR) ON DUPLICATE KEY UPDATE response=VALUES(response)',
    [key, JSON.stringify(response)],
  );
}
```

24 小时窗口够用。生产用 Redis 也行，TTL 设 24h。

边界：
- key 是空 / null → 不查、不缓存（就是希望每次都执行）
- 缓存命中但请求 input 不一样 → 当作冲突 422 拒绝（防止 LLM 把不同 input 共用 key）

---

## 6. 审批集成

两种模式：

### 6.1 同步（gateway 等审批）

```ts
// gateway 内
const approval = await approvalSystem.create({
  user: erpUser,
  operation: env.operation,
  payload: env.input,
});

// 长轮询（最大 60s）
const result = await approvalSystem.waitFor(approval.id, { timeoutMs: 60_000 });
if (result.status === 'approved') { /* execute */ }
else if (result.status === 'pending') { /* 返回 pending，让 agent 之后查询 */ }
else { /* denied */ }
```

agent 需要 `erp_get_approval_status` 类的工具？建议在 `erp_describe` 里暴露专用 operation：
- `system.approval.status` 输入 approvalId 返回状态

### 6.2 异步（gateway 立即返回 pending）

```ts
return res.json({
  ok: false,
  status: 'pending_approval',
  approvalId: approval.id,
  message: '已提交审批，请等待审批人响应',
});
```

agent 收到后通常会回复用户"已提交审批"。审批通过后由审批系统主动推 ERP，跟 FrontLane 没关系。FrontLane 不需要知道结果。

如果业务上必须 agent 知道结果：审批通过后由你们的系统通过另一个通道（飞书消息推送给原用户、或调用 FrontLane 的某个 schedule_task webhook）告知。

---

## 7. HMAC 签名（生产强烈推荐）

### 7.1 配置

FrontLane 侧（每个 group 的 `container.json`）：
```json
{
  "enterpriseGateway": {
    "baseUrl": "https://erp-gw.example.com/api/agent",
    "signingKey": "<32-byte hex secret>",
    "timeoutMs": 15000
  }
}
```

签名内容：
```
HMAC-SHA256(signingKey, timestamp + "\n" + nonce + "\n" + body)
```

请求头：
```
x-frontlane-timestamp: <ISO 8601>
x-frontlane-nonce: <随机字符串>
x-frontlane-signature: <hex>
```

### 7.2 Gateway 校验实现

```ts
import crypto from 'crypto';

const SIGNING_KEY = process.env.FRONTLANE_SIGNING_KEY!; // 跟 FrontLane 一致

function verifySignature(req: express.Request, rawBody: string): boolean {
  const ts = req.header('x-frontlane-timestamp');
  const nonce = req.header('x-frontlane-nonce');
  const sig = req.header('x-frontlane-signature');
  if (!ts || !nonce || !sig) return false;

  // 时间窗口（5 分钟）
  const skew = Math.abs(Date.now() - new Date(ts).getTime());
  if (skew > 5 * 60 * 1000) return false;

  // 防重放（Redis 或内存里记 nonce，TTL = 时间窗口）
  if (await nonceSeen(nonce)) return false;
  await markNonce(nonce, 5 * 60);

  const expected = crypto
    .createHmac('sha256', Buffer.from(SIGNING_KEY, 'hex'))
    .update(`${ts}\n${nonce}\n${rawBody}`)
    .digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}
```

⚠️ Express 默认 body parsing 会丢原始字节，签名校验需要 raw body：

```ts
app.use(express.json({
  verify: (req, _res, buf) => { (req as any).rawBody = buf.toString('utf8'); },
}));
```

---

## 8. 审计

你方至少要记的字段：

| 字段 | 来源 |
|---|---|
| `frontlane_user_id` | `requester.userId` |
| `erp_user_id` | 映射后的内部 id |
| `operation` | `operation` |
| `input_redacted` | `input` 去敏后的版本 |
| `requester_source` | `requesterSource`（trust level） |
| `agent_group_id` | `agent.agentGroupId` |
| `idempotency_key` | 透传 |
| `result_status` | success / failed / approval_pending |
| `created_at` | NOW() |
| `signing_verified` | bool（HMAC 是否校验成功） |

跟 FrontLane 的 `erp_audit` **互为参照**：
- FrontLane 那边记的是"我发了什么调用，结果是什么 HTTP code"
- 你这边记的是"我收到了什么调用，做了什么决定"
- 两边对不上 = 有问题

---

## 9. Memory 模型

`erp_memory_get` / `erp_memory_upsert` 给 agent 一个跨会话的 KV 存储。

推荐 namespace 划分：

| namespace | 用途 |
|---|---|
| `user.profile` | 员工画像（部门、汇报关系、偏好） |
| `user.preferences` | 偏好（沟通风格、常用查询、默认参数） |
| `user.summary` | agent 写的"上次对话摘要" |
| `business.<entity>` | 业务实体上下文（客户、项目、订单的延续状态） |
| `approval.history` | 该用户最近的审批记录 |

实现要点：
- 按 `(frontlane_user_id, namespace, key)` 三元组主键
- 不要把 PII 直接落到 memory（用 reference id 指向你的 ERP）
- 加一层访问控制：agent 不能跨 user 读 memory（永远以 `requester.userId` 为 scope）
- value 长度限制（建议单条 < 8KB），超长压成摘要

```sql
CREATE TABLE agent_memory (
  user_id VARCHAR(128),
  namespace VARCHAR(64),
  key VARCHAR(128),
  value TEXT,
  updated_at TIMESTAMP,
  PRIMARY KEY (user_id, namespace, key)
);
```

---

## 10. PII / 数据合规

注意点：

1. **input 不一定是用户输入**：可能是 agent 拼出来的查询条件，可能含其他用户 id。先 sanitize 再写日志。
2. **error message 别裸露 stack**：返给 FrontLane 的 error 是 agent 看的，agent 会读出来给用户。脱敏。
3. **memory 加密**：含敏感信息的 value 用 AES-256 加密，DB 只存密文。
4. **保留期**：审计日志按合规要求保留（中国 PIPL 一般 3 年）。memory 跟员工绑定，离职后清。
5. **跨境**：如果 FrontLane host 在境内、ERP 在境外（或反之），全部走境内代理 + 数据本地化。

---

## 11. 性能

单网关参考目标（1000 员工）：

| 指标 | 目标 |
|---|---|
| `/describe` P99 | < 50ms（强缓存） |
| `/authorize` P99 | < 100ms |
| `/execute`（读操作）P99 | < 500ms |
| `/execute`（写操作）P95 | < 2s（含审批等待） |
| `/memory/get` P99 | < 100ms |

调优：
- `/describe` 1 分钟内进程内缓存（变化不频繁）
- 身份映射 LRU 缓存
- ERP 慢的话用本地副本 / 物化视图
- 审批走异步（pending 立即返回）

FrontLane 默认 `timeoutMs=15000`。超时 → agent 看到 `gateway_timeout`，会跟用户说"系统繁忙稍后重试"。

---

## 12. 测试 ERP gateway

### 12.1 单元测试

针对 `mapToErpUser` / `checkPermission` / 签名校验单测。

### 12.2 集成测试 (用 FrontLane 当 client)

```bash
# 启动你的 gateway
node gateway.js  # listening on :3001

# 配 FrontLane
pnpm configure:enterprise-gateway --base-url http://localhost:3001

# 启动 FrontLane
pnpm dev

# 在 CLI channel 模拟一个用户消息
pnpm exec tsx scripts/cli-send.ts "查一下我的订单"

# 看 erp_audit
sqlite3 data/v2.db "select * from erp_audit order by created_at desc limit 5"
```

### 12.3 Chaos 测试

- 网关返 500：FrontLane 应该让 agent 跟用户说"系统暂时不可用"
- 网关 timeout：同上
- 网关返 200 但 body 不合协议：FrontLane 应记 audit + agent 友好降级
- HMAC 错的请求：网关 401 + 你这边记 audit

---

## 13. 上线 checklist

- [ ] HMAC 签名打开（`signingKey` 配置）
- [ ] 时间窗口 + nonce 防重放
- [ ] 身份映射的 fallback 路径（飞书 API 挂时怎么办）
- [ ] 权限默认 deny（未知 operation → 拒绝）
- [ ] 写操作有 `requiresApproval: true`
- [ ] `agent-asserted` 写操作硬拒
- [ ] 幂等 24h 窗口
- [ ] PII redaction 在写日志前
- [ ] 审计有索引（`(frontlane_user_id, created_at)` / `(operation, created_at)`）
- [ ] 监控：每个端点的 P50 / P95 / P99 / error rate
- [ ] dryRun 走通：每个写 operation 都能 dryRun

---

## 14. 故障排查

### 14.1 FrontLane 报"gateway returned 401"

- HMAC 没配 / signingKey 不一致 / 时间不同步（NTP）
- 你方记 audit 的 `signing_verified` 字段帮定位

### 14.2 agent 说"操作被拒"但用户应该有权限

- 看 FrontLane `erp_audit` 的 `requester_source`
- 是 `agent-asserted` 的写操作？正常被拒
- 是 `session` 但仍被拒 → 看你方的 authorize 日志

### 14.3 同样的请求 agent 重复执行

- 容器 retry 没传 `idempotencyKey`？
- 你方 idempotency 表 TTL 太短？
- 多副本网关之间没共享 idempotency 存储（用 Redis 集中）

### 14.4 memory 读出旧值 / 写没生效

- 多副本网关之间内存不共享 → 必须中心化（DB / Redis）
- 缓存层 TTL 跟 upsert 不一致

---

## 15. 进一步阅读

- [enterprise-erp-gateway.md](enterprise-erp-gateway.md) — 完整协议
- [PLATFORM.md](PLATFORM.md) — 平台总览
- [RUNBOOK.md](RUNBOOK.md) — 运维手册（FrontLane 侧的 audit / 故障排查）

# FrontLane Runbook — 运维 / SRE 手册

面向运维和 oncall。线上出问题时该看哪里、怎么诊断、怎么处置都在这里。

读者预设：已经读过 [PLATFORM.md](PLATFORM.md) 顶层概览，知道三 DB 模型 + 容器拓扑。

---

## 1. 健康检查清单（每天一遍）

按顺序看，任一异常进入对应章节。

| 检查 | 命令 / Panel | 期望 |
|---|---|---|
| 进程活着 | `launchctl list \| grep frontlane` 或 `systemctl --user status frontlane` | running |
| `/metrics` 返回 200 | `curl -s localhost:3000/metrics \| head -3` | `# HELP ...` |
| 飞书入站速率 | `rate(frontlane_inbound_total{outcome="accepted"}[5m])` | 与业务时段一致 |
| 入站去重比例 | `rate(...{outcome="deduped"}) / rate(...{outcome="accepted"})` | < 5%（飞书重投正常） |
| 路由 P95 延迟 | `histogram_quantile(0.95, rate(frontlane_route_seconds_bucket{phase="route"}[5m]))` | < 0.5s |
| 唤醒 P95 延迟 | 同上 phase="wake" | < 2s（冷启动会高） |
| 活跃 session 数 | `frontlane_session_count{status="active"}` | 跟工作时间相关，无突刺 |
| 容器异常退出 | `rate(frontlane_container_exits_total{outcome=~"crash\|killed"}[15m])` | ≈ 0 |
| 唤醒拒绝 | `rate(frontlane_wake_rejected_total[5m])` | 持续 0；瞬时尖峰可接受 |
| 分类协议绕过 | `rate(frontlane_classification_bypass_total[15m])` | ≈ 0 |
| 分类日志写入失败 | `rate(frontlane_classification_log_failures_total[15m])` | 必须 0 |
| Provider 错误 | `rate(frontlane_provider_errors_total[5m])` | ≈ 0 |

---

## 2. 告警阈值建议

```yaml
# 入站完全停了：飞书 webhook 挂了 / 服务挂了 / 网络
- alert: FrontlaneInboundSilent
  expr: rate(frontlane_inbound_total{outcome="accepted"}[10m]) == 0
  for: 10m
  severity: critical

# 路由延迟劣化：DB 锁、磁盘 IO、容器启动慢
- alert: FrontlaneRouteSlow
  expr: histogram_quantile(0.95, rate(frontlane_route_seconds_bucket{phase="route"}[5m])) > 1.0
  for: 5m
  severity: warning

# 唤醒延迟劣化：Docker daemon 慢、镜像问题
- alert: FrontlaneWakeSlow
  expr: histogram_quantile(0.95, rate(frontlane_route_seconds_bucket{phase="wake"}[5m])) > 5.0
  for: 5m
  severity: warning

# 容量饱和：MAX_CONCURRENT_CONTAINERS 持续打满
- alert: FrontlaneCapacitySaturated
  expr: rate(frontlane_wake_rejected_total[10m]) > 0.5
  for: 10m
  severity: warning

# 分类协议失效：frontdesk LLM 在跳过 classify_intent
- alert: FrontlaneClassificationBypass
  expr: rate(frontlane_classification_bypass_total[15m]) > 0.1
  for: 30m
  severity: warning

# 审计写失败：分类日志在丢
- alert: FrontlaneClassificationLogFailing
  expr: rate(frontlane_classification_log_failures_total[5m]) > 0
  for: 5m
  severity: critical

# Provider 错误率：LLM 网关挂了 / 配额耗尽
- alert: FrontlaneProviderErrors
  expr: rate(frontlane_provider_errors_total[5m]) > 0.5
  for: 5m
  severity: warning

# 容器崩溃风暴：镜像问题 / 系统资源
- alert: FrontlaneContainerCrashing
  expr: rate(frontlane_container_exits_total{outcome="crash"}[10m]) > 0.2
  for: 10m
  severity: critical
```

---

## 3. 常见故障诊断

### 3.1 用户报"机器人不回复"

排查顺序：

```bash
# 1. 最近 200 行 host 日志
tail -200 logs/frontlane.log

# 2. 错误日志（delivery 失败 / crash-loop / warning）
tail -200 logs/frontlane.error.log

# 3. 入站是否到达
sqlite3 data/v2.db "select count(*), max(created_at) from inbound_dedup where created_at > datetime('now','-1 hour')"

# 4. 找到这个用户的活跃 session
sqlite3 data/v2.db \
  "select id, agent_group_id, owner_user_id, last_active_at, status
   from sessions where owner_user_id = 'feishu:ou_xxx' order by last_active_at desc limit 5"

# 5. 看 session 的 inbound.db 是否有未处理消息
sqlite3 data/v2-sessions/<agent_group>/<session>/inbound.db \
  "select id, status, kind, tries, timestamp from messages_in order by timestamp desc limit 10"

# 6. 看 outbound.db 是否有产出
sqlite3 data/v2-sessions/<agent_group>/<session>/outbound.db \
  "select id, kind, status, created_at from messages_out order by created_at desc limit 10"
```

诊断决策树：

| 症状 | 含义 | 处置 |
|---|---|---|
| `inbound_dedup` 没新行 | 飞书 webhook 没到 | 看飞书开放平台事件投递日志 + WEBHOOK_PORT 是否暴露 |
| inbound_dedup 有，session.last_active_at 不更新 | 路由失败 | 看 `frontlane.error.log` 的 routeInbound 错误 |
| messages_in 有 status=pending 但 outbound 没新行 | 容器没起来 / 死循环 | 看 `docker ps`，看 host-sweep 是否标 stuck |
| messages_out 有 status=pending | delivery 失败 | 看 `frontlane.error.log` 的 deliver 错误 + 飞书 SDK 错误 |
| messages_out delivered 了，用户没看到 | 飞书发送了但用户视角没收到 | 飞书侧面问题（消息撤回 / 群退出 / 卡片渲染失败） |

### 3.2 `wake_rejected_total{reason="capacity"}` 持续非 0

**含义**：`MAX_CONCURRENT_CONTAINERS` 已饱和，host-sweep 在重试。

**短期处置**：
```bash
# 看当前在跑多少容器
docker ps --filter ancestor=nanoclaw-agent:latest | wc -l

# 看是不是有僵尸容器
docker ps -a --filter ancestor=nanoclaw-agent:latest --filter status=exited

# 调高上限（重启服务后生效）
echo 'MAX_CONCURRENT_CONTAINERS=20' >> .env
launchctl kickstart -k gui/$(id -u)/com.nanoclaw   # macOS
# systemctl --user restart frontlane                # Linux
```

**根因排查**：
- 是不是某个 agent 卡住没退出？看 `host-sweep` 的 stuck 检测有没有把它干掉。
- 是不是 `FRONTLANE_IDLE_EXIT_MS` 没开导致容器永不退？建议设 `120000`（2 分钟）。
- 是不是真的在线人数涨了？开启 idle exit + 调高上限。

### 3.3 `classification_bypass_total` 持续非 0

**含义**：frontdesk LLM 在跳过 `classify_intent` 工具直接派活，或者派出去的 surface 跟声明的 action 不一致。

**按 reason 标签拆**：
- `no_classification_id`：完全没调工具就发消息。Prompt 漂了，或者模型跨版本回归。
- `classification_not_found`：调了但 id 找不到（跨 session id 复用）。LLM 在串号。
- `action_mismatch`：声明 delegate 实际发了 channel reply（或反之）。frontdesk 在"既然 worker 派出去了顺便给用户也回一句"。

**处置**：
```bash
# 看具体哪些 turn 在 bypass
sqlite3 data/v2.db \
  "select created_at, classification_id, action, recommended_worker, confidence, outcome_ref
   from classification_log
   where outcome_ref is null
   order by created_at desc limit 30"

# 看分类决策的实际分布
sqlite3 data/v2.db \
  "select action, count(*) from classification_log
   where created_at > datetime('now','-1 day')
   group by action"
```

如果分布严重偏向 `delegate`（>90%），frontdesk 不在做"该不该 clarify"的判断 → 重审 frontdesk system prompt。

### 3.4 容器崩溃风暴 (`container_exits_total{outcome="crash"}` 升高)

```bash
# 最近退出的容器
docker ps -a --filter ancestor=nanoclaw-agent:latest \
  --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}' | head

# 看 host-sweep 标记的退出原因
grep "container exit" logs/frontlane.log | tail -50

# 集中在某个 agent_group？
sqlite3 data/v2.db \
  "select agent_group_id, count(*) from sessions
   where status='closed' and last_active_at > datetime('now','-1 hour')
   group by agent_group_id order by count(*) desc"
```

**注意**：容器是 `--rm` 跑的，退出后日志全丢。要捞容器内栈，先跑一个不 `--rm` 的复现：
```bash
docker run --rm=false --name fl-debug -v ... nanoclaw-agent:latest ...
# 复现后
docker logs fl-debug
```

或者临时改 `src/container-runner.ts` 把 `--rm` 摘掉做调试，记得改回来。

### 3.5 ERP gateway 调用失败

```bash
# 最近的失败 audit 行
sqlite3 data/v2.db \
  "select created_at, user_id, operation, requester_source, http_status, duration_ms
   from erp_audit
   where http_status >= 400
   order by created_at desc limit 30"

# 单个用户的近期操作
sqlite3 data/v2.db \
  "select created_at, operation, http_status, duration_ms
   from erp_audit where user_id='feishu:ou_xxx'
   order by created_at desc limit 50"

# 慢调用 (>5s)
sqlite3 data/v2.db \
  "select operation, count(*), avg(duration_ms), max(duration_ms)
   from erp_audit
   where created_at > datetime('now','-1 day') and duration_ms > 5000
   group by operation"
```

**`requester_source='agent-asserted'` 的写操作**应该在 ERP 后端被拒绝（弱信号身份）。如果发现 audit 里 source=agent-asserted 但操作 success=200，是后端策略漏洞。

### 3.6 Session 表膨胀

```bash
# 各状态的 session 数
sqlite3 data/v2.db "select status, count(*) from sessions group by status"

# 归档目录大小
du -sh data/v2-sessions-archive/ 2>/dev/null

# 没归档但很久没活动的（TTL 没起作用？）
sqlite3 data/v2.db \
  "select count(*) from sessions
   where status='active' and last_active_at < datetime('now','-30 days')"
```

如果 active 里有大量很久没动的 session：检查 `FRONTLANE_SESSION_TTL_DAYS` 是否配置；host-sweep 每 60s 跑一次归档。

物理删归档：手动跑（不会自动跑除非配 `FRONTLANE_ARCHIVE_HARD_DELETE_DAYS`）：
```bash
find data/v2-sessions-archive/ -name '*.tar' -mtime +90 -ls
# 确认无误后再删
```

---

## 4. 容量与资源

### 4.1 单 host 容量参考

针对 1 vCPU / 2GB 容器配置：

| 资源维度 | 单 session 占用 | 1000 员工估算 |
|---|---|---|
| 容器内存 | ~1GB（worker） / ~768MB（frontdesk） | 峰值 10 容器 ≈ 10GB host RAM |
| 容器 CPU | 1 core | 峰值 10 容器 ≈ 10 core |
| Session DB 存储 | ~5MB（一个月对话） | 1000 session × 5MB ≈ 5GB |
| 中央 DB | 增长慢，主要看 audit 表 | 一年 < 1GB |

**结论**：单 host 16C32G 跑 1000 员工 + `MAX_CONCURRENT_CONTAINERS=10` 完全够用，瓶颈是 LLM 调用延迟而不是 host 资源。

### 4.2 调资源配额

每个 agent_group 的 `groups/<folder>/container.json`：
```json
{
  "resources": {
    "memoryMb": 1024,
    "cpus": 1,
    "pidsLimit": 512
  }
}
```

调高个别 worker（比如做密集数据处理的）：
```bash
# 编辑后无需重启 host，下次 wake 容器就生效
vim groups/frontlane-finance-worker/container.json
```

注意：手动改的不会被 `pnpm init:enterprise` 覆盖。

---

## 5. 数据库维护

### 5.1 中央 DB 备份

```bash
# Online backup（不锁表）
sqlite3 data/v2.db ".backup /backup/v2-$(date +%Y%m%d).db"

# Vacuum（很久没做的话回收空间）
sqlite3 data/v2.db "vacuum"
```

建议：每天 backup，每周 vacuum。

### 5.2 Audit 表归档

`erp_audit` / `classification_log` / `enterprise_audit` 会持续增长。半年以上的可以导出归档：

```bash
sqlite3 data/v2.db <<SQL
.mode csv
.output /backup/erp-audit-2025H1.csv
select * from erp_audit where created_at < '2026-01-01';
.output stdout
delete from erp_audit where created_at < '2026-01-01';
SQL

sqlite3 data/v2.db "vacuum"
```

合规要求长期保留的话别 delete，只 export。

### 5.3 Session DB 损坏恢复

如果 host-sweep 报某个 session 的 DB 不可读：

```bash
# 备份
cp -r data/v2-sessions/<group>/<session>/ /tmp/fl-recovery/

# 试着 dump
sqlite3 data/v2-sessions/<group>/<session>/inbound.db ".dump" > /tmp/inbound.sql
sqlite3 data/v2-sessions/<group>/<session>/outbound.db ".dump" > /tmp/outbound.sql

# 如果完全坏了，标记 session 为 closed，让用户开新会话
sqlite3 data/v2.db \
  "update sessions set status='closed' where id='<session_id>'"
```

下次该用户发消息会 resolve 出新 session。历史对话在备份里。

---

## 6. 升级 / 部署

### 6.1 版本升级流程

```bash
# 1. Backup
sqlite3 data/v2.db ".backup /backup/pre-upgrade-$(date +%s).db"

# 2. 拉新代码
git fetch && git checkout v2.0.x

# 3. 装依赖
pnpm install --frozen-lockfile

# 4. 跑 migrations（host 启动时会自动跑，但建议先看一遍 DDL）
ls src/db/migrations/

# 5. 重建容器镜像（如果 container/agent-runner/ 有变化）
./container/build.sh

# 6. 重启
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 7. 健康检查
curl -s localhost:3000/metrics | head
```

### 6.2 Migration 不可逆性

`src/db/migrations/*` 都用 `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` 模式，**只能向前**。

- 升级前 backup 是回滚的唯一手段
- 不要手改 schema_version 表
- 不要并发跑 migration（host 启动时 advisory lock）

### 6.3 灰度（暂未支持）

当前是单 host 设计，灰度方案：
- 临时方案：复制一份代码到另一个目录、用不同 `WEBHOOK_PORT`、把部分用户的飞书事件路由到新实例
- 推荐方案：等多机房支持落地

---

## 7. Incident 调查

### 7.1 找到一条具体消息的全链路

用户报"我刚才 14:23 发的消息没回复"：

```bash
# 1. inbound dedup 有没有？
sqlite3 data/v2.db \
  "select * from inbound_dedup where created_at > '2026-05-09 14:23:00' limit 5"

# 2. 找到这个用户的 session
sqlite3 data/v2.db \
  "select id, agent_group_id from sessions where owner_user_id='feishu:ou_xxx' order by last_active_at desc limit 1"

# 3. session inbound 里看 message id
sqlite3 data/v2-sessions/<group>/<session>/inbound.db \
  "select id, kind, status, tries, timestamp from messages_in
   where timestamp > '2026-05-09 14:23:00' order by timestamp"

# 4. session outbound 里追产出
sqlite3 data/v2-sessions/<group>/<session>/outbound.db \
  "select id, kind, in_reply_to, status, created_at from messages_out
   where created_at > '2026-05-09 14:23:00' order by created_at"

# 5. 如果是 frontdesk 派活：跨 session 追 origin_user_id
sqlite3 data/v2-sessions/<worker_group>/<worker_session>/inbound.db \
  "select id, origin_user_id, content from messages_in
   where origin_user_id='feishu:ou_xxx' order by timestamp desc limit 5"

# 6. ERP 调用？
sqlite3 data/v2.db \
  "select * from erp_audit where user_id='feishu:ou_xxx'
   and created_at > '2026-05-09 14:23:00'"

# 7. 分类决策？
sqlite3 data/v2.db \
  "select * from classification_log where session_id='<frontdesk_session>'
   and created_at > '2026-05-09 14:23:00'"
```

### 7.2 ERP 写错了 / 误操作

```bash
# 找到这次操作的 audit 行
sqlite3 data/v2.db \
  "select * from erp_audit
   where operation='<op_name>' and user_id='<user>'
   order by created_at desc limit 5"

# 拿 input_hash 在 ERP 后端反查具体载荷（hash 是去敏的，原始 input 由 ERP 后端保留）

# 看是不是 agent-asserted 来源（弱信号）
# 如果 requester_source='agent-asserted' 而后端却放行了 → 后端策略 bug
```

---

## 8. 紧急处置

### 8.1 关闭飞书入口

不停服务，只关入口（消息会在飞书侧堆积，up to 7 天）：

```bash
# 选项 A：飞书开放平台关闭事件订阅
# 选项 B：让 webhook 返回 403
# 在 src/channels/feishu.ts 的 handler 顶部临时 return res.writeHead(503)
```

### 8.2 强行清空所有 in-flight

```bash
# 杀所有 agent 容器（用户消息会丢一拍）
docker ps --filter ancestor=nanoclaw-agent:latest -q | xargs docker kill

# 重置所有 in-flight inbound 状态
for db in data/v2-sessions/*/*/inbound.db; do
  sqlite3 "$db" "update messages_in set status='pending' where status='processing'"
done

# 重启 host
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

### 8.3 临时屏蔽某个用户

```bash
# 在 messaging_groups 上临时改 unknown_sender_policy=reject
# 或者删除这个用户的 user_dms 缓存让 autowire 不再生效
sqlite3 data/v2.db "delete from user_dms where user_id='feishu:ou_xxx'"
```

正式方案：在 ERP gateway 拒绝该 user_id 的所有 operation。

---

## 9. 文件位置速查

| 文件 / 目录 | 含义 |
|---|---|
| `logs/frontlane.log` | 主日志 |
| `logs/frontlane.error.log` | 错误 + warning |
| `data/v2.db` | 中央 DB |
| `data/v2-sessions/<group>/<session>/inbound.db` | session 入站（host 写） |
| `data/v2-sessions/<group>/<session>/outbound.db` | session 出站（容器写） |
| `data/v2-sessions-archive/` | TTL 归档的 tar |
| `groups/<folder>/container.json` | 容器资源配置 |
| `groups/<folder>/CLAUDE.md` | 该 agent group 的 system prompt |
| `.env` | 环境变量（FEISHU_*, OPENAI_*, FRONTLANE_*） |

---

## 10. 反向求助

无法定位的问题，提交工单时附上：

1. `logs/frontlane.log` 最近 1000 行
2. `logs/frontlane.error.log` 全部
3. `curl -s localhost:3000/metrics` 输出
4. `docker ps -a --filter ancestor=nanoclaw-agent:latest`
5. 涉及的 user_id、session_id、approximate timestamp
6. `sqlite3 data/v2.db ".schema sessions"` + 故障 session 的行

不要把 session DB 整个发出去（含对话内容）。先 `sanitize`：
```bash
sqlite3 data/v2-sessions/.../inbound.db \
  "select id, kind, status, tries, length(content) from messages_in"
```

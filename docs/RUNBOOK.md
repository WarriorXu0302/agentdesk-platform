# AgentDesk Runbook — 运维 / SRE 手册

面向运维和 oncall。线上出问题时该看哪里、怎么诊断、怎么处置都在这里。

读者预设：已经读过 [PLATFORM.md](PLATFORM.md) 顶层概览，知道三 DB 模型 + 容器拓扑。

> 本文用默认品牌命名空间 `agentdesk` 书写。指标前缀、服务名、日志文件名随 `BRAND_NAMESPACE` 派生；下文示例按默认值。

---

## 1. 健康检查清单（每天一遍）

按顺序看，任一异常进入对应章节。

host 是裸 Node 进程，由操作员的进程管理器拉起。`deploy/` 提供 systemd / launchd
**单元模板**（填 `<PLACEHOLDERS>` 后安装，见 `deploy/README.md`）；若你用的是自己的
单元名，"进程活着"按你的服务名查，否则一律按 host 健康探针 `/healthz` 查。

| 检查 | 命令 / Panel | 期望 |
|---|---|---|
| 进程活着 | `pgrep -f 'node .*dist/index.js' \|\| pgrep -f 'tsx .*src/index.ts'` 有 PID；再探 `curl -fsS localhost:3000/healthz` | 返回 PID + `/healthz` 200 |
| 就绪态（DB / 容器 runtime 可用） | `curl -fsS localhost:3000/readyz` | 200 |
| `/metrics` 返回 200 | `curl -s localhost:3000/metrics \| head -3` | `# HELP ...` |
| 飞书入站速率 | `rate(agentdesk_inbound_total{outcome="accepted"}[5m])` | 与业务时段一致 |
| 入站去重比例 | `rate(...{outcome="deduped"}) / rate(...{outcome="accepted"})` | < 5%（飞书重投正常） |
| 路由 P95 延迟 | `histogram_quantile(0.95, rate(agentdesk_route_seconds_bucket{phase="route"}[5m]))` | < 0.5s |
| 唤醒 P95 延迟 | 同上 phase="wake" | < 2s（冷启动会高） |
| 活跃 session 数 | `agentdesk_session_count{status="active"}` | 跟工作时间相关，无突刺 |
| 容器异常退出 | `rate(agentdesk_container_exits_total{outcome=~"crash\|killed"}[15m])` | ≈ 0 |
| 唤醒拒绝 | `rate(agentdesk_wake_rejected_total[5m])` | 持续 0；瞬时尖峰可接受 |
| 分类协议绕过 | `rate(agentdesk_classification_bypass_total[15m])` | ≈ 0 |
| 分类日志写入失败 | `rate(agentdesk_classification_log_failures_total[15m])` | 必须 0 |
| Provider 错误 | `rate(agentdesk_provider_errors_total[5m])` | ≈ 0 |
| 入站路由失败（静默丢失） | `rate(agentdesk_inbound_ingress_failed_total[10m])` | 必须 0（→ §3.7） |
| 入站重试耗尽（死信） | `rate(agentdesk_inbound_processing_permanent_failures_total[15m])` | 必须 0（→ §3.7） |
| 网关代签冒充 | `rate(agentdesk_gateway_signing_proxy_total{outcome="identity_mismatch"}[15m])` | 必须 0（安全；→ §3.8） |
| 网关代签审计写失败 | `rate(agentdesk_gateway_signing_proxy_total{outcome="audit_write_failed"}[15m])` | 必须 0（审计留痕在出洞；→ §3.8） |
| 未签名网关组 | `agentdesk_gateway_unsigned_groups` | 0（生产；→ §3.8） |
| engage 正则失效 | `rate(agentdesk_engage_pattern_invalid_total[10m])` | 必须 0（→ §3.9） |

---

## 2. 告警阈值建议

> 这些规则的**承载体**是 `infra/observability/prometheus/alerts.yml`，由本仓内的 Prometheus 容器加载、Alertmanager 寻呼（见 [ADR-0021](decisions/ADR-0021-metrics-alerting-loop.md)）。下面的 YAML 是同一份规则的人类可读副本 + 阈值理由；改阈值要两边一起改，`scripts/runbook-consistency.test.ts` 不校验告警 YAML，但 `pnpm obs:rules:check`（promtool）会校验 `alerts.yml` 语法。
>
> ⚠️ 指标前缀 `agentdesk_` 是默认品牌（`METRIC_PREFIX`，由 `BRAND_NAMESPACE` 派生）。rebrand 后 host 发的是 `<新 namespace>_*`，下面所有规则与 `alerts.yml` 里的 `agentdesk_` 都要相应替换，否则规则永远不触发。

```yaml
# 入站完全停了：飞书 webhook 挂了 / 服务挂了 / 网络
- alert: AgentDeskInboundSilent
  expr: rate(agentdesk_inbound_total{outcome="accepted"}[10m]) == 0
  for: 10m
  severity: critical

# 路由延迟劣化：DB 锁、磁盘 IO、容器启动慢
- alert: AgentDeskRouteSlow
  expr: histogram_quantile(0.95, rate(agentdesk_route_seconds_bucket{phase="route"}[5m])) > 1.0
  for: 5m
  severity: warning

# 唤醒延迟劣化：Docker daemon 慢、镜像问题
- alert: AgentDeskWakeSlow
  expr: histogram_quantile(0.95, rate(agentdesk_route_seconds_bucket{phase="wake"}[5m])) > 5.0
  for: 5m
  severity: warning

# 容量饱和：MAX_CONCURRENT_CONTAINERS 持续打满
- alert: AgentDeskCapacitySaturated
  expr: rate(agentdesk_wake_rejected_total[10m]) > 0.5
  for: 10m
  severity: warning

# 分类协议失效：frontdesk LLM 在跳过 classify_intent
- alert: AgentDeskClassificationBypass
  expr: rate(agentdesk_classification_bypass_total[15m]) > 0.1
  for: 30m
  severity: warning

# 审计写失败：分类日志在丢
- alert: AgentDeskClassificationLogFailing
  expr: rate(agentdesk_classification_log_failures_total[5m]) > 0
  for: 5m
  severity: critical

# Provider 错误率：LLM 网关挂了 / 配额耗尽
- alert: AgentDeskProviderErrors
  expr: rate(agentdesk_provider_errors_total[5m]) > 0.5
  for: 5m
  severity: warning

# 容器崩溃风暴：镜像问题 / 系统资源
- alert: AgentDeskContainerCrashing
  expr: rate(agentdesk_container_exits_total{outcome="crash"}[10m]) > 0.2
  for: 10m
  severity: critical
```

---

## 3. 常见故障诊断

### 3.1 用户报"机器人不回复"

排查顺序：

> 日志：host 把 info 写 stdout、warn/error 写 stderr（见 `src/log.ts`），**不写文件**。日志获取方式取决于你怎么拉起 host：
> - 进程管理器（pm2 / supervisor / nohup 重定向）→ 看它的日志文件
> - systemd 单元（如果你自己加了）→ `journalctl --user -u <你的单元名> -n 200`
> - 前台 / tmux → 直接看终端
> 下文用 `<host-logs>` 占位代表"你这套部署里 host stdout+stderr 的去处"。

```bash
# 1. 最近 200 行 host 日志（按你的进程管理器取；示例：pm2）
#    pm2 logs agentdesk --lines 200    /    journalctl --user -u <unit> -n 200
<host-logs> | tail -200

# 2. 只看 error/warn（host 把它们写 stderr）
<host-logs> 2>&1 | grep -E 'ERROR|WARN|FATAL' | tail -200

# 3. 入站是否到达（inbound_dedup 用 seen_at）
sqlite3 data/v2.db "select count(*), max(seen_at) from inbound_dedup where seen_at > datetime('now','-1 hour')"

# 4. 找到这个用户的活跃 session（sessions 用 last_active）
sqlite3 data/v2.db \
  "select id, agent_group_id, owner_user_id, last_active, status
   from sessions where owner_user_id = 'feishu:ou_xxx' order by last_active desc limit 5"

# 5. 看 session 的 inbound.db 是否有未处理消息
sqlite3 data/v2-sessions/<agent_group>/<session>/inbound.db \
  "select id, status, kind, tries, timestamp from messages_in order by timestamp desc limit 10"

# 6. 看 outbound.db 是否有产出（messages_out 用 timestamp）
sqlite3 data/v2-sessions/<agent_group>/<session>/outbound.db \
  "select id, kind, in_reply_to, timestamp from messages_out order by timestamp desc limit 10"
```

诊断决策树：

出站投递状态不在 `messages_out`（容器写、无 status 列），而在 host 写的 `inbound.db.delivered` 表（`status` ∈ delivered/failed）。下表"messages_out status" 的判断实际查 `delivered`。

| 症状 | 含义 | 处置 |
|---|---|---|
| `inbound_dedup` 没新行 | 飞书 webhook 没到 | 看飞书开放平台事件投递日志 + WEBHOOK_PORT 是否暴露 |
| inbound_dedup 有，session.last_active 不更新 | 路由失败 | 在 host stderr 里 grep `routeInbound` 错误 |
| messages_in 有 status=pending 但 outbound 没新行 | 容器没起来 / 死循环 | 看 `docker ps`，看 host-sweep 是否标 stuck |
| `delivered.status='failed'`（或 messages_out 有行但 delivered 无对应行） | delivery 失败 | 在 host stderr 里 grep `deliver` 错误 + 飞书 SDK 错误 |
| `delivered.status='delivered'` 了，用户没看到 | 飞书发送了但用户视角没收到 | 飞书侧面问题（消息撤回 / 群退出 / 卡片渲染失败） |

### 3.2 `wake_rejected_total{reason="capacity"}` 持续非 0

**含义**：`MAX_CONCURRENT_CONTAINERS` 已饱和，host-sweep 在重试。

> 镜像名不是固定串。host 派生为 `<brand_namespace>-agent-v2-<install_slug>:latest`（默认 `agentdesk-agent-v2-<8位 hash>`，见 `container/build.sh` 与 `src/install-slug.ts`）——两份 checkout 在同一台机器上 slug 不同。所以不要 `--filter ancestor=<固定名>`，按本平台镜像前缀过滤：
>
> ```bash
> # 本机本平台的镜像（默认前缀 agentdesk-agent-v2-；rebrand 后换成你的 namespace）
> docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^agentdesk-agent-v2-'
> # 把它存成变量复用
> IMG="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^agentdesk-agent-v2-' | head -n1)"
> ```

**短期处置**：
```bash
# 看当前在跑多少本平台容器
docker ps --filter ancestor="$IMG" | wc -l

# 看是不是有僵尸容器
docker ps -a --filter ancestor="$IMG" --filter status=exited

# 调高上限（重启 host 后生效）
echo 'MAX_CONCURRENT_CONTAINERS=20' >> .env
# 重启 host：用你拉起它的进程管理器（pm2 restart / systemctl --user restart <你的单元> / 重跑启动脚本）
```

**根因排查**：
- 是不是某个 agent 卡住没退出？看 `host-sweep` 的 stuck 检测有没有把它干掉。
- 是不是 `AGENTDESK_IDLE_EXIT_MS` 没开导致容器永不退？建议设 `120000`（2 分钟）。
- 是不是真的在线人数涨了？开启 idle exit + 调高上限。

### 3.3 `classification_bypass_total` 持续非 0

**含义**：frontdesk LLM 在跳过 `classify_intent` 工具直接派活，或者派出去的 surface 跟声明的 action 不一致。

**按 reason 标签拆**：
- `no_classification_id`：完全没调工具就发消息。Prompt 漂了，或者模型跨版本回归。
- `classification_not_found`：调了但 id 找不到（跨 session id 复用）。LLM 在串号。
- `action_mismatch`：声明 delegate 实际发了 channel reply（或反之）。frontdesk 在"既然 worker 派出去了顺便给用户也回一句"。

**处置**：
```bash
# 看具体哪些 turn 在 bypass（classification_log 用 occurred_at）
sqlite3 data/v2.db \
  "select occurred_at, classification_id, action, recommended_worker, confidence, outcome_ref
   from classification_log
   where outcome_ref is null
   order by occurred_at desc limit 30"

# 看分类决策的实际分布
sqlite3 data/v2.db \
  "select action, count(*) from classification_log
   where occurred_at > datetime('now','-1 day')
   group by action"
```

如果分布严重偏向 `delegate`（>90%），frontdesk 不在做"该不该 clarify"的判断 → 重审 frontdesk system prompt。

### 3.4 容器崩溃风暴 (`container_exits_total{outcome="crash"}` 升高)

（`$IMG` 同 §3.2：`docker images ... | grep -E '^agentdesk-agent-v2-'` 取本平台镜像。）

```bash
# 最近退出的容器
docker ps -a --filter ancestor="$IMG" \
  --format 'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}' | head

# 看 host-sweep 标记的退出原因（host stderr/stdout，按你的进程管理器取）
<host-logs> 2>&1 | grep "container exit" | tail -50

# 集中在某个 agent_group？（sessions 用 last_active）
sqlite3 data/v2.db \
  "select agent_group_id, count(*) from sessions
   where status='closed' and last_active > datetime('now','-1 hour')
   group by agent_group_id order by count(*) desc"
```

**注意**：容器是 `--rm` 跑的，退出后日志全丢。要捞容器内栈，先跑一个不 `--rm` 的复现：
```bash
docker run --rm=false --name fl-debug -v ... "$IMG" ...
# 复现后
docker logs fl-debug
```

或者临时改 `src/container-runner.ts` 把 `--rm` 摘掉做调试，记得改回来。

### 3.5 后端网关调用失败

（`gateway_audit` 用 `occurred_at`；结果状态在 `status` 列，HTTP 码在 `http_status`。）

```bash
# 最近的失败 audit 行
sqlite3 data/v2.db \
  "select occurred_at, user_id, operation, requester_source, status, http_status, duration_ms
   from gateway_audit
   where http_status >= 400
   order by occurred_at desc limit 30"

# 单个用户的近期操作
sqlite3 data/v2.db \
  "select occurred_at, operation, status, http_status, duration_ms
   from gateway_audit where user_id='feishu:ou_xxx'
   order by occurred_at desc limit 50"

# 慢调用 (>5s)
sqlite3 data/v2.db \
  "select operation, count(*), avg(duration_ms), max(duration_ms)
   from gateway_audit
   where occurred_at > datetime('now','-1 day') and duration_ms > 5000
   group by operation"
```

**`requester_source='agent-asserted'` 的写操作**应该在后端被拒绝（弱信号身份）。如果发现 audit 里 `requester_source='agent-asserted'` 但 `http_status` 是 2xx（成功放行），是后端策略漏洞。

### 3.6 Session 表膨胀

```bash
# 各状态的 session 数
sqlite3 data/v2.db "select status, count(*) from sessions group by status"

# 归档目录大小
du -sh data/v2-sessions-archive/ 2>/dev/null

# 没归档但很久没活动的（TTL 没起作用？sessions 用 last_active）
sqlite3 data/v2.db \
  "select count(*) from sessions
   where status='active' and last_active < datetime('now','-30 days')"
```

如果 active 里有大量很久没动的 session：检查 `AGENTDESK_SESSION_TTL_DAYS` 是否配置；host-sweep 每 60s 跑一次归档。

物理删归档：手动跑（不会自动跑除非配 `AGENTDESK_ARCHIVE_HARD_DELETE_DAYS`）：
```bash
find data/v2-sessions-archive/ -name '*.tar' -mtime +90 -ls
# 确认无误后再删
```

---

### 3.7 入站消息静默丢失（`inbound_ingress_failed_total` / `inbound_processing_permanent_failures_total` 非 0）

两类"用户发了消息但没人回"的静默丢失，都有专门的恢复路径：

**(a) 路由前就失败** —— `inbound_ingress_failed_total`。消息已落 ingress 恢复账本（ADR-0022）
但 `routeInbound` 抛错（session inbound.db 忙 / 附件 IO / 中央 DB 瞬时错误），停在
`status='failed'`，从未进 session。
```bash
# 看积压的失败入站（中央 DB 的 inbound_ingress 账本）
sqlite3 data/v2.db "select channel_type, count(*) from inbound_ingress where status='failed' group by 1"
# 操作员显式重放（不会自动重放——避免绕过 adapter 层去重）
pnpm exec tsx scripts/replay-inbound.ts --help
```
> 注意：host 重启时会把账本里的存量 failed 重新计入该指标（`__startup_backlog__` 标签），
> 所以重启后的一次性 fire 可能是存量再现，不一定是新失败。

**(b) 容器反复崩在某条消息上、重试耗尽** —— `inbound_processing_permanent_failures_total`。
host-sweep 重置 `MAX_TRIES`(5) 次后把该 `messages_in` 行标 `status='failed'`，不再被 poll
（出站 DLQ 的入站镜像）。先查是不是某个 group 的容器在崩（→ §3.4），修好后再 requeue：
```bash
# 列出所有 session 里 status='failed' 的入站死信
pnpm exec tsx scripts/requeue-inbound.ts --list
# requeue 某条（重置 status='pending', tries=0；下一次 sweep/wake 会重投）
pnpm exec tsx scripts/requeue-inbound.ts --session <sessionId> --message <messageId>
```

### 3.8 网关身份/签名告警（`gateway_signing_proxy_total` / `gateway_unsigned_groups`）

- `gateway_signing_proxy_total{outcome="identity_mismatch"}` 非 0：**安全事件**。proxy 模式容器
  请求体里声明的 group 与其 token 绑定的 group 不符（ADR-0034）—— 提示注入冒充。查 `gateway_audit`
  里 `identity_mismatch=1` 的行（`signed_as_group` / `token_jti` / `proxy_request_id`）定位会话。
- `gateway_signing_proxy_total{outcome="no_signing_key"}` 非 0：proxy 已开但某 group host 侧无
  signingKey，其网关调用 fail-closed(502)。
- `gateway_unsigned_groups > 0`：某 group 有 baseUrl 但无 signingKey，其后端请求**未签名可伪造**
  （ADR-0018）。
```bash
# 给相关 group 配/补签名密钥（不会把已签名的降级回未签名）
pnpm exec tsx scripts/configure-enterprise-gateway.ts --help
```

- `gateway_signing_proxy_total{outcome="audit_write_failed"}` 非 0：代签审计写中央 DB 失败，**审计链在出洞**——
  CLAUDE.md 把 `gateway_audit` 列为 load-bearing，必须排查。分两段看（ADR-0034）：forward **之前**的 intent 写是
  **fail-closed**——写不进就拒签、返回 503，请求根本没发出，不会留下无审计留痕的已签发调用；forward **之后**的
  finalize 写是 best-effort——失败时后端调用已经发生，但那行停在 `audit_phase='intent'` / `status='pending'`，
  留痕不完整。根因多为中央 DB 压力（busy_timeout 撑不住 / 磁盘将满 → SQLITE_BUSY/SQLITE_FULL，见 §3.10）。host
  重启时 `reconcileOrphanedProxyAudit` 会把存量 `intent` 行收尾成 error（`error_msg` 带 `[orphaned_intent_reconciled]`），
  所以重启后的一次性尖峰可能是存量再现，不一定是新失败。先看积压的未收尾行，再查 DB 压力 / 磁盘：
```bash
# 停在 intent/pending 的代签审计行（finalize 没写上 → 审计留痕有洞）
sqlite3 data/v2.db \
  "select occurred_at, proxy_request_id, agent_group_id, path, operation, status, error_msg
   from gateway_audit where audit_phase='intent' order by occurred_at desc limit 30"
```

### 3.9 某 agent 的 engage 正则失效（`engage_pattern_invalid_total` 非 0）

某 agent 的 `engage_pattern` 正则没编译过 → 该 agent fail-closed、**静默丢弃它的全部入站**
（ADR-0019），直到正则修好。host stderr 会有 `engage_pattern failed to compile` 的 warn，
带 `agent_group` 和坏 `pattern`。改对应 group 的 `engage_pattern`（container.json / DB），
下次入站即恢复。

### 3.10 磁盘将满（`data_dir_free_ratio` 偏低）

单机最常见的"慢性"故障:中央 DB 不大,但每个长生命周期 session 的 inbound/outbound.db +
`inbox/<msgId>/` 附件目录**只增不减**(整 session 归档默认 OFF),磁盘填满后三个库齐发
`SQLITE_FULL`,入站/出站全停。host-sweep 每 tick 采样 DATA_DIR 空闲比例到
`agentdesk_data_dir_free_ratio`(<0.10 告警,<0.05 critical)。处置:
```bash
# 看占用大头(会话 DB + 附件)
du -sh data/v2-sessions/* 2>/dev/null | sort -h | tail -20
du -sh data/ data/v2.db data/v2-sessions-archive/ 2>/dev/null
```
- 开 session 归档:`AGENTDESK_SESSION_TTL_DAYS=N`(把久不活动的 session 打包进归档目录,
  释放其 DB + 附件);久了再物理删归档(见 §3.6 / §5)。
- 开审计保留:`AGENTDESK_AUDIT_RETAIN_DAYS=N`(host-sweep 修剪 gateway_audit /
  classification_log / enterprise_audit / dm_audit 旧行;默认 0=永不删)。
- 或直接扩卷。

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
vim groups/agentdesk-finance-worker/container.json
```

注意：手动改的不会被 `pnpm init:enterprise` 覆盖。

---

## 5. 数据库维护

### 5.1 备份(中央 DB + 所有会话 DB)

**用 `scripts/backup.sh`**——它在线快照 `v2.db` **以及每个会话的 inbound/outbound.db**
(手动只备 `v2.db` 会漏掉所有会话的在途消息与投递账本)。

```bash
# 一次性
DATA_DIR=./data BACKUP_DIR=./backups scripts/backup.sh

# cron(每天 03:00,保留最近 14 份)
0 3 * * *  cd /srv/agentdesk && BACKUP_RETAIN=14 scripts/backup.sh >> /var/log/agentdesk-backup.log 2>&1

# Vacuum（很久没做的话回收空间）
sqlite3 data/v2.db "vacuum"
```

**RPO = 快照间隔**:两次备份之间崩溃会丢这段时间的变更——按你的 RPO 定运行频率,
更紧的 RPO 用卷快照/流式方案。建议：每天 backup,每周 vacuum。

### 5.2 Audit 表归档

`gateway_audit` / `classification_log` / `enterprise_audit` 会持续增长。半年以上的可以导出归档：

```bash
# gateway_audit / classification_log 都用 occurred_at；enterprise_audit 见其建表 DDL。
sqlite3 data/v2.db <<SQL
.mode csv
.output /backup/gateway-audit-2025H1.csv
select * from gateway_audit where occurred_at < '2026-01-01';
.output stdout
delete from gateway_audit where occurred_at < '2026-01-01';
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
pnpm container:build   # = bash container/build.sh，镜像名由 brand namespace + install slug 派生

# 6. 重启 host（用你拉起它的进程管理器：pm2 restart / systemctl --user restart <你的单元> / 重跑启动脚本）

# 7. 健康检查
curl -fsS localhost:3000/readyz && curl -s localhost:3000/metrics | head
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
# 1. inbound dedup 有没有？（inbound_dedup 用 seen_at）
sqlite3 data/v2.db \
  "select * from inbound_dedup where seen_at > '2026-05-09 14:23:00' limit 5"

# 2. 找到这个用户的 session（sessions 用 last_active）
sqlite3 data/v2.db \
  "select id, agent_group_id from sessions where owner_user_id='feishu:ou_xxx' order by last_active desc limit 1"

# 3. session inbound 里看 message id
sqlite3 data/v2-sessions/<group>/<session>/inbound.db \
  "select id, kind, status, tries, timestamp from messages_in
   where timestamp > '2026-05-09 14:23:00' order by timestamp"

# 4. session outbound 里追产出（messages_out 用 timestamp，无 status 列）
sqlite3 data/v2-sessions/<group>/<session>/outbound.db \
  "select id, kind, in_reply_to, timestamp from messages_out
   where timestamp > '2026-05-09 14:23:00' order by timestamp"

# 5. 如果是 frontdesk 派活：跨 session 追 origin_user_id
sqlite3 data/v2-sessions/<worker_group>/<worker_session>/inbound.db \
  "select id, origin_user_id, content from messages_in
   where origin_user_id='feishu:ou_xxx' order by timestamp desc limit 5"

# 6. 后端调用？（gateway_audit 用 occurred_at）
sqlite3 data/v2.db \
  "select * from gateway_audit where user_id='feishu:ou_xxx'
   and occurred_at > '2026-05-09 14:23:00'"

# 7. 分类决策？（classification_log 用 occurred_at）
sqlite3 data/v2.db \
  "select * from classification_log where session_id='<frontdesk_session>'
   and occurred_at > '2026-05-09 14:23:00'"
```

### 7.2 后端写错了 / 误操作

```bash
# 找到这次操作的 audit 行（gateway_audit 用 occurred_at）
sqlite3 data/v2.db \
  "select * from gateway_audit
   where operation='<op_name>' and user_id='<user>'
   order by occurred_at desc limit 5"

# 拿 input_hash 在后端反查具体载荷（hash 是去敏的，原始 input 由后端保留）

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
# 杀所有 agent 容器（用户消息会丢一拍）。$IMG 取法见 §3.2。
IMG="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^agentdesk-agent-v2-' | head -n1)"
docker ps --filter ancestor="$IMG" -q | xargs docker kill

# 重置所有 in-flight inbound 状态
for db in data/v2-sessions/*/*/inbound.db; do
  sqlite3 "$db" "update messages_in set status='pending' where status='processing'"
done

# 重启 host（用你的进程管理器；本平台不带 launchd/systemd 单元）
```

### 8.3 临时屏蔽某个用户

```bash
# 在 messaging_groups 上临时改 unknown_sender_policy=reject
# 或者删除这个用户的 user_dms 缓存让 autowire 不再生效
sqlite3 data/v2.db "delete from user_dms where user_id='feishu:ou_xxx'"
```

正式方案：在后端网关拒绝该 user_id 的所有 operation。

---

## 9. 文件位置速查

| 文件 / 目录 | 含义 |
|---|---|
| host stdout（`<host-logs>`，由你的进程管理器捕获） | info 日志 |
| host stderr（同上） | warn + error + fatal |
| `data/v2.db` | 中央 DB |
| `data/v2-sessions/<group>/<session>/inbound.db` | session 入站（host 写） |
| `data/v2-sessions/<group>/<session>/outbound.db` | session 出站（容器写） |
| `data/v2-sessions-archive/` | TTL 归档的 tar |
| `groups/<folder>/container.json` | 容器资源配置 |
| `groups/<folder>/CLAUDE.md` | 该 agent group 的 system prompt |
| `.env` | 环境变量（FEISHU_*, OPENAI_*, AGENTDESK_*） |

---

## 10. 反向求助

无法定位的问题，提交工单时附上：

1. host stdout 最近 1000 行（按你的进程管理器导出）
2. host stderr 全部（warn/error/fatal）
3. `curl -s localhost:3000/metrics` 输出
4. `docker ps -a --filter ancestor="$IMG"`（`$IMG` 取法见 §3.2）
5. 涉及的 user_id、session_id、approximate timestamp
6. `sqlite3 data/v2.db ".schema sessions"` + 故障 session 的行

不要把 session DB 整个发出去（含对话内容）。先 `sanitize`：
```bash
sqlite3 data/v2-sessions/.../inbound.db \
  "select id, kind, status, tries, length(content) from messages_in"
```

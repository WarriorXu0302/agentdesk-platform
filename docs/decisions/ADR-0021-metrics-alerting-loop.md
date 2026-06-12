# ADR-0021: 指标必须有抓取者与告警承载体 — Prometheus + Alertmanager 闭环

- **Status**: Accepted
- **Date**: 2026-06-12
- **Decider(s)**: 用户（项目负责人）；coding agent（提案 + 执行）
- **Tags**: `observability`, `metrics`, `alerting`, `runbook`
- **Supersedes**: 无
- **Superseded by**: 无

---

## Context

host 在 `src/metrics.ts` 用 `prom-client` 暴露了一整套 `<namespace>_*` 指标（默认 `agentdesk_*`），挂在共享 webhook 端口的 `GET /metrics` 上。但落地审计发现这条链路是**断的**：

1. **没有抓取者**：`infra/observability/docker-compose.prod.yml` 只有 postgres / phoenix / grafana 三个服务，没有任何东西去 scrape host 的 `/metrics`。指标发出来无人采集。
2. **Grafana 的 prometheus datasource 配错**：唯一的 prometheus 类型 datasource（`Phoenix Metrics`）指向 `http://phoenix:9090`——那是 Phoenix 自己的 scrape 端点（供别人来抓），不是可查询的 Prometheus API，PromQL 永远查不出东西。
3. **告警规则无承载体**：`docs/RUNBOOK.md §2` 写了 8 条阈值告警 YAML，但没有任何系统加载它们。等于一份"建议"躺在文档里，线上不会触发。
4. **RUNBOOK 漂移**：运维手册里大量 copy-paste SQL 用了已被 migration 改名的列（`created_at` vs `occurred_at`/`seen_at`/`timestamp`、`last_active_at` vs `last_active`）、硬编码了过时镜像名（`nanoclaw-agent:latest`）和不存在的 launchd 单元（`com.nanoclaw`）、引用了不存在的日志文件。3am oncall 照抄会全失败。

ADR-0007 锁定的观测栈是"纯 Phoenix + Grafana"，其中 Phoenix 负责 **LLM trace**（prompt 树、token、tool call），Grafana 负责"系统指标 + 业务 KPI 综合面板"。ADR-0007 没有指定 metrics 的**存储与告警后端**——它把 trace 与 metrics 的职责边界留白了。本 ADR 填这块空白，且不触碰 ADR-0007 的 trace 决议。

已知约束：
- 不得违反 CLAUDE.md 的 "observability 只读" 不变量：抓取 / 告警链路不能改身份信任链或消息流。
- host 是容器外的裸 Node 进程；抓取者必须能跨 Docker host 边界访问 `host.docker.internal:WEBHOOK_PORT`。
- 指标前缀随 `BRAND_NAMESPACE` 派生（`METRIC_PREFIX`，`src/branding.ts`）；告警规则不能假死锁死品牌。

## Options Considered

- **Option A — Prometheus（scrape + rules）+ Alertmanager，落到现有 observability compose**：
  - Prometheus 抓 host `/metrics`、加载 `alerts.yml`、把 firing alert 推给 Alertmanager；Alertmanager 做去重/分组/寻呼。
  - 优点：Prometheus 文本格式正是 `prom-client` 已经在发的；行业标准；Grafana 原生 datasource；告警规则是声明式文件，可被 promtool 校验、可进 CI。
  - 缺点：多两个容器（Prometheus + Alertmanager）的运维点。
  - 工作量：低（配置 + compose 接线，无 src 改动）。
- **Option B — 让 Phoenix 兼任 metrics 告警**：Phoenix 内建 prometheus 指标端点，能不能直接用它做查询/告警？
  - 不可行：Phoenix 的 `:9090` 是它自身指标的 **scrape 源**，不是通用 PromQL 查询/告警引擎，也不抓外部 target。ADR-0007 明确 Phoenix 的职责是 trace，不是 metrics 告警后端。继续误用只会延续现在的配错。
- **Option C — Grafana 自带的 alerting（unified alerting）直接查 datasource 出告警**：
  - 优点：少一个 Alertmanager 容器。
  - 缺点：告警规则变成 Grafana 内部状态（provisioning 也可，但比纯文本 rules 更绕），promtool 校验不了；与"规则是仓内声明式文件、可 CI 校验"的目标冲突。
- **Option D — 不做，继续只有 trace**：
  - 不可行：指标发了无人收、8 条告警永不触发，等于把容量饱和 / 分类协议绕过 / 容器崩溃风暴 / a2a 身份伪造这些**已经埋点的**严重信号丢进黑洞。

## Decision

> **拍板：选 Option A — Prometheus + Alertmanager，接进现有 observability compose。**

理由（可验证）：
1. **闭环可验证**：`pnpm obs:config` 解析 compose 合法；`pnpm obs:rules:check`（promtool）校验 `alerts.yml` 语法；Grafana `Prometheus` datasource 指向可查询的 `http://prometheus:9090`，`Platform Health` dashboard 的 PromQL 能出图。
2. **不碰 ADR-0007 的 trace 边界**：Phoenix 继续只管 trace；Prometheus 只抓 host `/metrics` 这一类 counter/gauge/histogram。两者职责正交，Grafana 同时挂 Phoenix Postgres（trace 关联）与 Prometheus（metrics）两个 datasource。
3. **告警规则是仓内声明式文件**：`infra/observability/prometheus/alerts.yml` 是 RUNBOOK §2 那 8 条的唯一承载体，可被 promtool 校验、可进未来 CI。RUNBOOK §2 降级为同一份规则的人类可读副本 + 阈值理由。
4. **只读不变量保持**：抓取是 Prometheus 主动 pull host `/metrics`（只读 HTTP GET），不写任何 DB、不碰身份信任链。

## Consequences

- **Positive**：
  - 指标从"发了没人收"变成"被抓取 + 可查询 + 会告警"。
  - 8 条 RUNBOOK 告警 + 新增的 DLQ 永久失败、a2a origin 拒绝（身份信任链）共 10 条规则真正生效。
  - 新增 `scripts/runbook-consistency.test.ts`：把 RUNBOOK 里 copy-paste SQL 依赖的 (表,列) 对，断言其存在于真实 schema 源（`src/db/schema.ts` + `src/db/migrations/*`），并禁止历史错列名（`last_active_at`）回归 —— 防止 RUNBOOK 再次漂移。
- **Negative**：
  - 多两个容器运维点（Prometheus + Alertmanager）。
  - Alertmanager 默认是 `null` receiver（不寻呼），要真正派单必须操作员填 Slack / 飞书 webhook / PagerDuty —— 这是有意的"开箱即跑、寻呼需配置"。
- **Neutral / Trade-offs**：
  - **告警前缀随 rebrand 变**：`alerts.yml` 和 RUNBOOK §2 都用默认 `agentdesk_` 前缀。一旦操作员改 `BRAND_NAMESPACE`，host 发的是 `<新 namespace>_*`，所有 `agentdesk_` 必须相应替换，否则规则永不触发。这一点在 `alerts.yml` 文件头、RUNBOOK §2、本 ADR 三处都写明。一致性测试**不**校验告警 YAML 的前缀（前缀是部署期变量，不是 schema），只校验 SQL 列名。
  - `/metrics` 鉴权：若 host 给 `/metrics` 加了 bearer token（并行任务可能引入），Prometheus 的 scrape 需要注入 token。`prometheus.yml` 留了注释说明，但因为 Prometheus 不展开配置文件里的 `${ENV}`，token 走 `credentials_file` 挂载或模板渲染，不能直接写进仓内文件。

## Implementation Notes

- 新增配置：
  - `infra/observability/prometheus/prometheus.yml` — scrape host `/metrics`（`host.docker.internal:3000`）+ 加载 rules + 指向 Alertmanager。
  - `infra/observability/prometheus/alerts.yml` — 10 条告警规则（RUNBOOK §2 的 8 条 + DLQ 永久失败 + a2a origin 拒绝）。
  - `infra/observability/alertmanager/alertmanager.yml` — 最小可用 `null` receiver + Slack/飞书/PagerDuty 接法注释。
- compose 接线：`docker-compose.prod.yml` 与 `docker-compose.sim.yml` 各加 `prometheus` + `alertmanager` 服务（端口 `9091` / `9093`，卷名沿用 `agentdesk_*` 模式，`extra_hosts: host.docker.internal:host-gateway` 让 Linux 也能跨边界抓）。
- Grafana：`grafana/provisioning/datasources/phoenix-postgres.yml` 把配错的 `Phoenix Metrics → phoenix:9090` 改为 `Prometheus → prometheus:9090`（`isDefault`）；`grafana/dashboards/platform-health.json` 新增 5 panel（inbound rate / route+wake p95 / container crash rate / delivery permanent failures / a2a origin rejected）。
- RUNBOOK：`docs/RUNBOOK.md` 修正列名漂移、镜像名（改为 `docker images | grep -E '^agentdesk-agent-v2-'` 过滤，不再硬编码 `nanoclaw-agent:latest`）、进程/重启方式（去掉 `launchctl ... com.nanoclaw`，改为 `/healthz` `/readyz` 探针 + 进程管理器）、日志获取（host 写 stdout/stderr，非 `logs/agentdesk.log` 文件）。
- 防漂移测试：`scripts/runbook-consistency.test.ts`（vitest，`pnpm obs:runbook:check`）。
- package.json 仅新增 `obs:rules:check` 与 `obs:runbook:check` 两条 `obs:*` 脚本，未动其它脚本。
- 上游 ADR：ADR-0007（观测栈选型，trace 归 Phoenix——本 ADR 不改其结论，只补 metrics 告警边界）、ADR-0011（host OTel）、ADR-0016（delivery resilience，DLQ 告警来源）、ADR-0017（identity origin 交叉验证，a2a 告警来源）。

## References

- ADR-0007（Observability 框架 — Phoenix + Grafana）：Phoenix 负责 trace，本 ADR 补 metrics 告警后端，不冲突。
- ADR-0016（Delivery Resilience）：`delivery_permanent_failures_total` 告警来源。
- ADR-0017（Identity Origin Cross-Validation）：`a2a_origin_rejected_total` 告警来源。
- `src/metrics.ts`（指标定义）、`src/branding.ts`（`METRIC_PREFIX` 派生）。
- `docs/RUNBOOK.md §2`（告警规则人类可读副本）。

# Observability Bootstrap

> 本目录是 observability 基础设施的落地点。提供 Phoenix OSS（trace）+ Prometheus/Alertmanager（metrics + 告警）+ Grafana 的 compose / provisioning / dashboards / 告警规则 / 运维脚本，不包含任何 host 或 runner 的 instrumentation 代码。
>
> 选型背景见 [ADR-0007](../../docs/decisions/ADR-0007-observability-phoenix-grafana.md)（观测栈选型，trace 归 Phoenix）与 [ADR-0021](../../docs/decisions/ADR-0021-metrics-alerting-loop.md)（metrics 抓取者 + 告警承载体 = Prometheus + Alertmanager）。

## 目的（Purpose）

- 为 host instrumentation 与 runner instrumentation 提供稳定的 trace / metrics 接收端点。
- 给运维人员稳定的 `pnpm obs:*` 命令，避免 ad-hoc `docker compose` 调用。
- 通过 Grafana provisioning 把 datasource、placeholder dashboard 固化在仓内，保证机器之间一致。

## 非目标（Non-Goals）

- 本目录不实现任何 host / runner / SDK 层的 span 发射代码（那属于 instrumentation 层）。
- 不引入 Logfire、Langfuse、OTel-only DIY、LGTM、Loki、Tempo 等其它 observability 后端。
- 不提供完整业务 dashboards；只随仓提供一张 `Platform Health` 核心指标 dashboard + `Observability Bootstrap` 说明页。
- **告警寻呼不开箱即用**：Prometheus 加载规则、Alertmanager 收 firing alert，但默认 receiver 是 `null`（不寻呼）。接 Slack / 飞书 / PagerDuty 需操作员在 `alertmanager/alertmanager.yml` 填 receiver（见文件内注释）。
- 不修改 identity 信任链（`RequestIdentity` / `origin_user_id` / HMAC / `gateway_audit`）；observability 必须只读化（Prometheus 是主动 pull host `/metrics`，纯只读 HTTP GET）。

## 前置条件（Prerequisites）

| 工具 | 版本 |
|---|---|
| Docker | Engine ≥ 24 |
| Docker Compose | v2（`docker compose`，非旧版 `docker-compose`） |
| pnpm | 项目已 `pnpm install` |
| 端口空闲 | `6006`、`4317`、`9090`、`9091`、`9093`、`3001`（host） |

> ⚠️ Grafana 不绑 host `3000`：host webhook 默认占用 `3000`，所以 Grafana 走 `3001`。
> ⚠️ 区分两个 `:9090`：Phoenix 内建指标端点（host `9090`）是 scrape **源**，不可查询；真正的可查询 Prometheus 走 host `9091`。

## 端口映射（Port Map）

| 服务 | host port | container port | 用途 |
|---|---|---|---|
| Phoenix UI / OTLP HTTP collector | `6006` | `6006` | Web UI + `/v1/traces` HTTP 接收 |
| Phoenix OTLP gRPC collector | `4317` | `4317` | gRPC trace 接收 |
| Phoenix Prometheus-compatible metrics | `9090` | `9090` | Phoenix 内建 Prometheus 指标端点（scrape 源，**不是**可查询 Prometheus，也不是独立容器） |
| Prometheus（可查询 + 告警） | `9091` | `9090` | 抓 host `/metrics`、加载 `alerts.yml`、推 Alertmanager；Grafana `Prometheus` datasource 指向它 |
| Alertmanager | `9093` | `9093` | 收 firing alert，去重/分组/寻呼（默认 `null` receiver） |
| Grafana | `3001` | `3000` | Grafana Web UI |
| Postgres | （internal） | `5432` | 仅 compose 网络内部使用，host 不暴露 |

## 镜像版本（Pinned Images）

| 服务 | tag |
|---|---|
| Phoenix | `arizephoenix/phoenix:version-8.0.0` |
| Postgres | `postgres:16` |
| Grafana | `grafana/grafana:11.0.0` |
| Prometheus | `prom/prometheus:v2.54.1` |
| Alertmanager | `prom/alertmanager:v0.27.0` |

> 严禁使用 `:latest`。所有镜像都用固定 tag。

## 起停 / 日志 / 配置 / 重置（Operator Commands）

所有命令都通过 `pnpm obs:*` 调用，避免直接敲 `docker compose`：

```bash
# 启动完整栈（Phoenix + Postgres + Grafana）
pnpm obs:up

# 仅启动 Phoenix sim 栈（最小冒烟用）
pnpm obs:up:sim

# 校验 compose 配置（不启动容器；用于 PR 前 sanity check）
pnpm obs:config

# 跟随完整栈日志
pnpm obs:logs

# 停止完整栈（保留数据卷）
pnpm obs:down

# 停止 sim 栈
pnpm obs:down:sim

# 销毁完整栈数据卷（⚠️ 不可恢复，所有 traces / dashboards / Postgres / Prometheus 数据全清）
pnpm obs:reset

# 校验告警规则语法（需要本地 docker；跑 promtool check rules）
pnpm obs:rules:check

# 跑 RUNBOOK ↔ schema 一致性测试（防 SQL 列名漂移）
pnpm obs:runbook:check
```

Compose 项目名是显式的：

- 完整栈：`agentdesk-observability-prod`
- sim 栈：`agentdesk-observability-sim`

这样 `docker compose ls` 能区分两个独立的 stack。

## 数据持久化（Data Locations）

使用 docker named volumes，宿主机文件系统不直接挂载：

| 卷名 | 用途 |
|---|---|
| `agentdesk_phoenix_sim_data` | sim 栈 Phoenix `/mnt/data`（仅 sim） |
| `agentdesk_phoenix_postgres_data` | 完整栈 Postgres `/var/lib/postgresql/data` |
| `agentdesk_grafana_data` | 完整栈 Grafana `/var/lib/grafana` |
| `agentdesk_prometheus_data` / `agentdesk_prometheus_sim_data` | 完整栈 / sim 栈 Prometheus TSDB `/prometheus` |
| `agentdesk_alertmanager_data` / `agentdesk_alertmanager_sim_data` | 完整栈 / sim 栈 Alertmanager `/alertmanager` |

`pnpm obs:down` 不删这些卷；`pnpm obs:reset` 删完整栈的卷。

## 数据清除（Wipe Procedure）

```bash
# 在确认要丢弃所有本地观测数据后再跑：
pnpm obs:reset
```

`pnpm obs:reset` 等价于：

```bash
docker compose -p agentdesk-observability-prod \
  -f infra/observability/docker-compose.prod.yml \
  down -v
```

> ⚠️ 这一步会同时删除 Phoenix 已采集的 traces、Grafana 中操作员手动新建过的视图（如果有）、以及读写 Postgres 数据。重置前请确认没有需要保留的演练数据。

## 凭据（Credentials）

local-only 默认值见 [`.env.example`](.env.example)：

```env
PHOENIX_POSTGRES_USER=phoenix
PHOENIX_POSTGRES_PASSWORD=phoenix_local_only
PHOENIX_POSTGRES_DB=phoenix
PHOENIX_POSTGRES_GRAFANA_USER=grafana_ro
PHOENIX_POSTGRES_GRAFANA_PASSWORD=grafana_readonly_local_only

GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=agentdesk-local-observability
GRAFANA_HOST_PORT=3001
```

- 真实部署务必通过环境变量覆盖这些值；**不要**把真实密码写入 `.env.example`。
- Grafana 匿名访问已禁用（`GF_AUTH_ANONYMOUS_ENABLED=false`），必须用 `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` 登录。
- Postgres 不向 host 暴露端口；仅 compose 网络内部可访问。
- Grafana 走的是 `grafana_ro` 只读角色，由 `init/grafana_readonly.sql` 在 Postgres 首次启动时创建。

## 首次启动检查清单（First-Run Checklist）

> 这部分是**手工 QA**。`pnpm test` 只能验证文件契约；docker 真容器要靠运维同学走一遍。

1. 复制环境变量：
   ```bash
   cp infra/observability/.env.example infra/observability/.env
   # 必要时编辑 .env 覆盖默认密码 / 端口
   ```
2. 校验 compose 配置：
   ```bash
   pnpm obs:config
   ```
   期望：两个 stack 都打印解析后的 yaml，无 unresolved variable 警告。
3. 启动完整栈：
   ```bash
   pnpm obs:up
   ```
4. 等 ~10 秒后探测 Phoenix UI：
   ```bash
   curl -fsS http://localhost:6006 >/dev/null && echo "phoenix ok"
   ```
5. 探测 Grafana 健康：
   ```bash
   curl -fsS http://localhost:3001/api/health
   ```
   期望返回 `{"database":"ok",...}` 形态的 JSON。
6. 验证 datasource 已 provisioning：
   ```bash
   curl -fsS \
     -u "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-agentdesk-local-observability}" \
     "http://localhost:3001/api/datasources/name/Phoenix%20Postgres"
   ```
   期望返回非空 JSON，`type` 为 `postgres`，`uid` 为 `phoenix-postgres`。
7. 验证占位 dashboard 已加载：
   ```bash
   curl -fsS \
     -u "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-agentdesk-local-observability}" \
     "http://localhost:3001/api/search?query=Observability%20Bootstrap"
   ```
   期望返回至少 1 条结果。
8. 验证 Prometheus 起来且抓到 host（host 须在本机跑、`/metrics` 可达）：
   ```bash
   curl -fsS http://localhost:9091/-/healthy && echo " prometheus ok"
   # 查抓取目标状态：agentdesk-host 的 health 应为 up（host 没跑时为 down，属正常）
   curl -fsS "http://localhost:9091/api/v1/targets" | grep -o '"health":"[a-z]*"'
   ```
9. 验证 Alertmanager 起来：
   ```bash
   curl -fsS http://localhost:9093/-/healthy && echo " alertmanager ok"
   ```
10. 浏览器打开：
    - Phoenix：<http://localhost:6006>
    - Prometheus：<http://localhost:9091>
    - Alertmanager：<http://localhost:9093>
    - Grafana：<http://localhost:3001>（默认 `admin` / `agentdesk-local-observability`，登录后查看 `Platform Health` dashboard）
11. 停止：
    ```bash
    pnpm obs:down
    ```

## 故障排查（Troubleshooting）

| 现象 | 可能原因 | 处理 |
|---|---|---|
| Grafana 起不来，host 3000 被占 | host webhook 默认占用 `3000` | 本 stack 用 `3001`；如果操作员误改回 `3000`，撤回改动 |
| Grafana 登录失败 | `GRAFANA_ADMIN_PASSWORD` 与 `.env` 不一致 | 重新 `pnpm obs:down && pnpm obs:up`，确认环境变量来源 |
| Phoenix 无法连 Postgres | Postgres 启动慢于 Phoenix（首次启动） | `pnpm obs:down && pnpm obs:up` 或等几秒后 `docker compose -p agentdesk-observability-prod restart phoenix` |
| `grafana_ro` 角色不存在 | Postgres 已经初始化过，`init/*.sql` 不会再次执行 | 用 `pnpm obs:reset` 销毁数据卷后重启（⚠️ 会丢 trace） |
| `pnpm obs:config` 警告 unresolved variables | host 没装载 `.env` | `set -a; source infra/observability/.env; set +a` 后再跑，或用 docker compose `--env-file` 选项 |
| Prometheus target `agentdesk-host` 显示 down | host 进程没跑 / `/metrics` 不可达 / 端口非 3000 | 先确认 host 在本机跑且 `curl localhost:3000/metrics` 有输出；端口非 3000 则改 `prometheus/prometheus.yml` 的 target |
| Grafana 面板空 / 告警不触发 | rebrand 后指标前缀变了，规则还用 `agentdesk_` | 把 `prometheus/alerts.yml` 与 dashboard 里的 `agentdesk_` 替换成新 namespace 前缀 |
| 告警 firing 但没人收到 | Alertmanager 默认 `null` receiver | 在 `alertmanager/alertmanager.yml` 填真实 receiver 并把 `route.receiver` 指过去 |

## Metrics 抓取与告警（Prometheus / Alertmanager）

详见 [ADR-0021](../../docs/decisions/ADR-0021-metrics-alerting-loop.md)。

- **抓取目标**：Prometheus 抓 host 的 `GET /metrics`。host 是容器外的裸 Node 进程，所以 scrape target 写死 `host.docker.internal:3000`（WEBHOOK_PORT 默认）。compose 用 `extra_hosts: host.docker.internal:host-gateway` 让 Linux 也能解析。
  - **改了 WEBHOOK_PORT**？直接编辑 `prometheus/prometheus.yml` 里的 target——Prometheus **不**展开配置文件里的 `${ENV}`，所以不能靠环境变量覆盖端口。
  - **`/metrics` 加了 bearer token**？（host 侧若引入鉴权）在 `prometheus.yml` 的 scrape job 里启用 `authorization: { type: Bearer, credentials_file: /etc/prometheus/host_metrics_token }`，把 token 文件挂进 Prometheus 容器（compose volume）。token **不要**写进仓内文件，用 secrets 挂载或模板渲染注入。
- **指标前缀随品牌变**：默认 `agentdesk_*`（`METRIC_PREFIX`，`src/branding.ts`）。rebrand 后 host 发 `<新 namespace>_*`，`prometheus/alerts.yml` 与 Grafana dashboard 里的 `agentdesk_` 都要相应替换，否则告警永不触发、面板永远空。
- **告警规则**：`prometheus/alerts.yml`（10 条），是 RUNBOOK §2 的承载体。`pnpm obs:rules:check` 用 promtool 校验语法。
- **寻呼**：`alertmanager/alertmanager.yml` 默认 `null` receiver（不寻呼）。接 Slack / 飞书 / PagerDuty 见文件内注释；Alertmanager 同样不展开 `${ENV}`，URL/token 走模板渲染或 secrets 挂载。
- **Grafana datasource**：`Prometheus`（uid `prometheus`）指向 `http://prometheus:9090`（可查询），`isDefault`；`Phoenix Postgres` 保留用于 trace 关联。`Platform Health` dashboard 用 PromQL 画 inbound rate / route+wake p95 / container crash rate / delivery permanent failures / a2a origin rejected。

## Instrumentation 接入（Instrumentation）

本目录只提供观测后端；span 发射在 host 与 runner 侧实现：

- Host 端 OTel / Phoenix 相关 env keys（`PHOENIX_OTLP_ENDPOINT`、`PHOENIX_COLLECTOR_ENDPOINT`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_SERVICE_NAME`、`PHOENIX_PROJECT_NAME`、`GRAFANA_HOST_PORT`）由 host 进程读取，向本栈 Phoenix 发 span。`OTEL_SERVICE_NAME` 默认派生为 `<namespace>-host`（默认 `agentdesk-host`）。
- Host-side OTel instrumentation 已落地，消息路径 trace 在 Phoenix UI 可见。
- Runner 侧因为 `@arizeai/openinference-instrumentation-anthropic` 不能自动 instrument `@anthropic-ai/claude-agent-sdk`，使用 manual / hybrid span，同样发到本栈。
- compose stack 自己的服务凭据走 [`infra/observability/.env`](.env.example)（local-only 默认值），与 host 端 env 文件分开维护。

## 相关文件（Related Files）

- [`docker-compose.sim.yml`](docker-compose.sim.yml) — Phoenix + Prometheus + Alertmanager 的最小 sim 栈
- [`docker-compose.prod.yml`](docker-compose.prod.yml) — 完整 Phoenix + Postgres + Prometheus + Alertmanager + Grafana 栈
- [`prometheus/prometheus.yml`](prometheus/prometheus.yml) — scrape host `/metrics` + 加载 rules + 指向 Alertmanager
- [`prometheus/alerts.yml`](prometheus/alerts.yml) — 10 条告警规则（RUNBOOK §2 承载体）
- [`alertmanager/alertmanager.yml`](alertmanager/alertmanager.yml) — Alertmanager 路由 + 占位 `null` receiver
- [`init/grafana_readonly.sql`](init/grafana_readonly.sql) — Postgres 首启动时创建 Grafana 只读角色
- [`grafana/provisioning/datasources/phoenix-postgres.yml`](grafana/provisioning/datasources/phoenix-postgres.yml) — Phoenix Postgres（trace）+ Prometheus（metrics）两个 datasource
- [`grafana/provisioning/dashboards/dashboards.yml`](grafana/provisioning/dashboards/dashboards.yml) — file provider
- [`grafana/dashboards/platform-health.json`](grafana/dashboards/platform-health.json) — 核心指标 dashboard
- [`grafana/dashboards/observability-bootstrap.json`](grafana/dashboards/observability-bootstrap.json) — bootstrap 说明页
- [`.env.example`](.env.example) — local-only 默认凭据
- [`../../docs/decisions/ADR-0007-observability-phoenix-grafana.md`](../../docs/decisions/ADR-0007-observability-phoenix-grafana.md) — 观测栈选型（trace）
- [`../../docs/decisions/ADR-0021-metrics-alerting-loop.md`](../../docs/decisions/ADR-0021-metrics-alerting-loop.md) — metrics 抓取 + 告警闭环

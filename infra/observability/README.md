# Observability Bootstrap (Phase 0b / PR-O1)

> 本目录是 MUAP **Phase 0b / PR-O1** 的 observability 基础设施落地点。仅提供 Phoenix OSS + Grafana 的 compose / provisioning / 占位 dashboards / 运维脚本，不包含任何 host 或 runner 的 instrumentation 代码。
>
> 上游决议：[ADR-0007](../../docs/decisions/ADR-0007-observability-phoenix-grafana.md)（观测栈选型）→ [ADR-0009](../../docs/decisions/ADR-0009-observability-bootstrap-contract.md)（本 PR 落地合同）。

## 目的（Purpose）

- 为后续 PR-O2（host instrumentation）与 PR-O3（runner instrumentation）提供稳定的 trace / metrics 接收端点。
- 给运维人员稳定的 `pnpm obs:*` 命令，避免 ad-hoc `docker compose` 调用。
- 通过 Grafana provisioning 把 datasource、placeholder dashboard 固化在仓内，保证机器之间一致。

## 非目标（Non-Goals）

- 不实现任何 host / runner / SDK 层的 span 发射代码（属于 PR-O2 / PR-O3）。
- 不引入 Logfire、Langfuse、OTel-only DIY、LGTM、Loki、Tempo 等其它 observability 后端。
- 不提供完整业务 dashboards；只保留一张 `MUAP Observability Bootstrap` 占位 dashboard，验证 provisioning 通路即可。
- 不实现 alerts、SLO、寻呼规则、通知 channel。
- 不修改 identity 信任链（`RequestIdentity` / `origin_user_id` / HMAC / `erp_audit`）；observability 必须只读化。

## 前置条件（Prerequisites）

| 工具 | 版本 |
|---|---|
| Docker | Engine ≥ 24 |
| Docker Compose | v2（`docker compose`，非旧版 `docker-compose`） |
| pnpm | 项目已 `pnpm install` |
| 端口空闲 | `6006`、`4317`、`9090`、`3001`（host） |

> ⚠️ Grafana 不绑 host `3000`：MUAP webhook 默认占用 `3000`，详见 [ADR-0009](../../docs/decisions/ADR-0009-observability-bootstrap-contract.md) §Port Allocation。

## 端口映射（Port Map）

| 服务 | host port | container port | 用途 |
|---|---|---|---|
| Phoenix UI / OTLP HTTP collector | `6006` | `6006` | Web UI + `/v1/traces` HTTP 接收 |
| Phoenix OTLP gRPC collector | `4317` | `4317` | gRPC trace 接收 |
| Phoenix Prometheus-compatible metrics | `9090` | `9090` | Phoenix 内建 Prometheus 指标端点（不是独立 Prometheus 容器） |
| Grafana | `3001` | `3000` | Grafana Web UI |
| Postgres | （internal） | `5432` | 仅 compose 网络内部使用，host 不暴露 |

## 镜像版本（Pinned Images）

| 服务 | tag |
|---|---|
| Phoenix | `arizephoenix/phoenix:version-8.0.0` |
| Postgres | `postgres:16` |
| Grafana | `grafana/grafana:11.0.0` |

> 严禁使用 `:latest`。`scripts/observability-bootstrap.test.ts` 会校验 pin。

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

# 销毁完整栈数据卷（⚠️ 不可恢复，所有 traces / dashboards / Postgres 数据全清）
pnpm obs:reset
```

Compose 项目名是显式的：

- 完整栈：`muap-observability-prod`
- sim 栈：`muap-observability-sim`

这样 `docker compose ls` 能区分两个独立的 stack。

## 数据持久化（Data Locations）

使用 docker named volumes，宿主机文件系统不直接挂载：

| 卷名 | 用途 |
|---|---|
| `muap_phoenix_sim_data` | sim 栈 Phoenix `/mnt/data`（仅 sim） |
| `muap_phoenix_postgres_data` | 完整栈 Postgres `/var/lib/postgresql/data` |
| `muap_grafana_data` | 完整栈 Grafana `/var/lib/grafana` |

`pnpm obs:down` 不会删除这三个卷；`pnpm obs:reset` 会。

## 数据清除（Wipe Procedure）

```bash
# 在确认要丢弃所有本地观测数据后再跑：
pnpm obs:reset
```

`pnpm obs:reset` 等价于：

```bash
docker compose -p muap-observability-prod \
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
GRAFANA_ADMIN_PASSWORD=frontlane-local-observability
GRAFANA_HOST_PORT=3001
```

- 真实部署务必通过环境变量覆盖这些值；**不要**把真实密码写入 `.env.example`。
- Grafana 匿名访问已禁用（`GF_AUTH_ANONYMOUS_ENABLED=false`），必须用 `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` 登录。
- Postgres 不向 host 暴露端口；仅 compose 网络内部可访问。
- Grafana 走的是 `grafana_ro` 只读角色，由 `init/grafana_readonly.sql` 在 Postgres 首次启动时创建（详见 [ADR-0009](../../docs/decisions/ADR-0009-observability-bootstrap-contract.md) §Read-Only Datasource Policy）。

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
     -u "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-frontlane-local-observability}" \
     "http://localhost:3001/api/datasources/name/Phoenix%20Postgres"
   ```
   期望返回非空 JSON，`type` 为 `postgres`，`uid` 为 `phoenix-postgres`。
7. 验证占位 dashboard 已加载：
   ```bash
   curl -fsS \
     -u "${GRAFANA_ADMIN_USER:-admin}:${GRAFANA_ADMIN_PASSWORD:-frontlane-local-observability}" \
     "http://localhost:3001/api/search?query=MUAP%20Observability%20Bootstrap"
   ```
   期望返回至少 1 条结果。
8. 浏览器打开：
   - Phoenix：<http://localhost:6006>
   - Grafana：<http://localhost:3001>（默认 `admin` / `frontlane-local-observability`，登录后到 `MUAP Observability` 文件夹查看 `MUAP Observability Bootstrap` dashboard）
9. 停止：
   ```bash
   pnpm obs:down
   ```

## 故障排查（Troubleshooting）

| 现象 | 可能原因 | 处理 |
|---|---|---|
| Grafana 起不来，host 3000 被占 | MUAP webhook 默认占用 `3000` | 本 stack 用 `3001`；如果操作员误改回 `3000`，撤回改动 |
| Grafana 登录失败 | `GRAFANA_ADMIN_PASSWORD` 与 `.env` 不一致 | 重新 `pnpm obs:down && pnpm obs:up`，确认环境变量来源 |
| Phoenix 无法连 Postgres | Postgres 启动慢于 Phoenix（首次启动） | `pnpm obs:down && pnpm obs:up` 或等几秒后 `docker compose -p muap-observability-prod restart phoenix` |
| `grafana_ro` 角色不存在 | Postgres 已经初始化过，`init/*.sql` 不会再次执行 | 用 `pnpm obs:reset` 销毁数据卷后重启（⚠️ 会丢 trace） |
| `pnpm obs:config` 警告 unresolved variables | host 没装载 `.env` | `set -a; source infra/observability/.env; set +a` 后再跑，或用 docker compose `--env-file` 选项 |
| `latest` tag 错误 | 任何 compose 文件被改成 `:latest` | `scripts/observability-bootstrap.test.ts` 会失败；恢复成 plan 指定的 pin tag |

## 与 Phase 0a env 提案的协同（Env Coordination）

- Host 端 OTel / Phoenix 相关 env keys（`PHOENIX_OTLP_ENDPOINT`、`PHOENIX_COLLECTOR_ENDPOINT`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`PHOENIX_PROJECT_NAME`、`GRAFANA_HOST_PORT`）由 [`scripts/generate-env-local-proposed.ts`](../../scripts/generate-env-local-proposed.ts) 写入 `.env.local.proposed`，**不**写入 `.env.local`，遵循 Phase 0a 的人工 review 流程（详见 [ADR-0008](../../docs/decisions/ADR-0008-phase0a-lab-frontdesk-onboarding.md)）。
- compose stack 自己的服务凭据走 [`infra/observability/.env`](.env.example)（local-only 默认值），与 host 端 env 文件分开维护。
- 姊妹仓 `openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example` 在本 PR 中是 **只读参考**；MUAP 在自家 generator 中扩展，不修改姊妹文件。

## 未来 PR 交接（Future PR Handoff）

| PR | 范围 | 与本 PR 的关系 |
|---|---|---|
| PR-O2 | host instrumentation | 复用 `PHOENIX_OTLP_ENDPOINT=http://localhost:4317`，向本栈 Phoenix 发 span |
| PR-O3 | runner instrumentation | 因为 `@arizeai/openinference-instrumentation-anthropic` 不能自动 instrument `@anthropic-ai/claude-agent-sdk`，需要 manual / hybrid span（Oracle ruling）；同样发到本栈 |
| 后续 dashboards | 完整业务视图 | 在本 PR 已就绪的 Grafana provisioning 目录下叠加；本 PR 只留占位 |

PR-O1 阶段**禁止**在 host 或 runner 里写任何 OTel / Phoenix import；测试 (`scripts/observability-bootstrap.test.ts`) 会守门。

## 相关文件（Related Files）

- [`docker-compose.sim.yml`](docker-compose.sim.yml) — Phoenix-only sim 栈
- [`docker-compose.prod.yml`](docker-compose.prod.yml) — 完整 Phoenix + Postgres + Grafana 栈
- [`init/grafana_readonly.sql`](init/grafana_readonly.sql) — Postgres 首启动时创建 Grafana 只读角色
- [`grafana/provisioning/datasources/phoenix-postgres.yml`](grafana/provisioning/datasources/phoenix-postgres.yml) — Phoenix Postgres + Phoenix Metrics 两个 datasource
- [`grafana/provisioning/dashboards/dashboards.yml`](grafana/provisioning/dashboards/dashboards.yml) — file provider
- [`grafana/dashboards/muap-observability-bootstrap.json`](grafana/dashboards/muap-observability-bootstrap.json) — 占位 dashboard
- [`.env.example`](.env.example) — local-only 默认凭据
- [`../../docs/decisions/ADR-0007-observability-phoenix-grafana.md`](../../docs/decisions/ADR-0007-observability-phoenix-grafana.md) — 观测栈选型
- [`../../docs/decisions/ADR-0008-phase0a-lab-frontdesk-onboarding.md`](../../docs/decisions/ADR-0008-phase0a-lab-frontdesk-onboarding.md) — Phase 0a 落地（env 流程协同来源）
- [`../../docs/decisions/ADR-0009-observability-bootstrap-contract.md`](../../docs/decisions/ADR-0009-observability-bootstrap-contract.md) — 本 PR 的合同 ADR

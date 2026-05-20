# ADR-0009: Observability Bootstrap Contract

- **Status**: Accepted
- **Date**: 2026-05-20
- **Decider(s)**: 用户（项目负责人）；coding agent（提案 / 执行 / 自审）
- **Tags**: `observability`, `phase0b`, `infra`, `migration`
- **Supersedes**: —
- **Superseded by**: —

---

## Context

[ADR-0007](ADR-0007-observability-phoenix-grafana.md) 已经把 observability 栈拍板为 **Phoenix OSS (ELv2 license) + Grafana**；[ADR-0006](ADR-0006-phase0b-parallel-observability.md) 把 Phase 0b 与 Phase 0a 并行，迁移宪法 v1.2（`../../../openclaw/CLOSEOUT/migration-to-muap.md`）把 Phase 0b 列为 OBSERVABILITY 工作包。

但 ADR-0007 只锁定了**栈**，没锁定**落地形态**：

- compose 文件分几层？sim vs full stack 怎么切？
- Grafana 装在 host 哪个端口？MUAP webhook 默认占 `3000`，Grafana 不能直接复用。
- Phoenix 指标暴露怎么处理——上独立 Prometheus 容器，还是用 Phoenix 自带的 Prometheus-compatible 端点？
- Grafana 进 Phoenix Postgres 用什么角色？read-write 角色会破坏 identity 信任链。
- env 提案怎么与 Phase 0a 的 `.env.local.proposed` 流程对齐？
- host / runner instrumentation 是否纳入本 PR？Oracle 已 ruling 过 `@arizeai/openinference-instrumentation-anthropic` 不能直接 instrument `@anthropic-ai/claude-agent-sdk`，runner 必须走 manual / hybrid span。

PR-O1 的目标是把以上所有"形态"问题锁死，使 PR-O2（host instrumentation）和 PR-O3（runner instrumentation）能在一个稳定的 substrate 上叠加而不再 re-litigate 基础设施决定。

约束（写本 ADR 时已知）：

- 不能改 `RequestIdentity` / `origin_user_id` / HMAC / `erp_audit` 任何身份信任链路径。
- 不能引入 Logfire、Langfuse、OTel-only DIY、LGTM、Loki、Tempo 等被 ADR-0007 否决过的方案。
- 不能动 `src/index.ts`、`src/router.ts`、`src/delivery.ts`、`src/host-sweep.ts`、`src/container-runner.ts` 或 `container/agent-runner/src/*` 任何 runtime 路径（instrumentation 属于 PR-O2/O3）。
- 姊妹仓 `openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example` 是只读参考；本 PR 在 MUAP 自家 generator 中扩展。

## Options Considered

- **Option A — Infra-only bootstrap PR + 后续 instrumentation 单独立 PR**：本 PR 只落 compose / provisioning / runbook / scripts / env 提案 / ADR；不动任何运行时代码。优点：边界明确，可独立回滚，跟 Oracle ruling 一致（runner instrumentation 复杂、需 PR-O3 单独处理）。缺点：必须严守 scope，需要测试守门防止 host/runner import OTel / Phoenix。工作量：≤0.5 工程日。
- **Option B — 一次性同时落 bootstrap + host instrumentation**：本 PR 同时引入 `@opentelemetry/*` 与 host span 发射。优点：用户更早看到真实 trace。缺点：blast radius 巨大、与 Phase 0a 才稳定下来的运行时强耦合、破坏"infra-only"的可回滚性、与 Oracle ruling 对 runner instrumentation 的 manual/hybrid 路径冲突（容易把 runner 也牵进来）。工作量：≥2 工程日，回归风险高。
- **Option C — 不立 ADR，只靠 compose / runbook / scripts 留痕**：完全不写 ADR-0009。优点：纸面工作最少。缺点：违反 [CLAUDE.md](../../CLAUDE.md) 的强制 ADR 要求；下一个 agent 看到 `infra/observability/` 不会知道"为什么 Grafana 在 3001 而不是 3000"或"为什么没有独立 Prometheus 容器"，会反向重做。

## Decision

> **拍板**：选 **Option A — Infra-only bootstrap PR**。

PR-O1 的范围严格限定为：

1. **Compose stacks**（两套）
   - `infra/observability/docker-compose.sim.yml`：Phoenix-only，最小冒烟用。
   - `infra/observability/docker-compose.prod.yml`：Phoenix + Postgres + Grafana。
2. **Image pinning**（不允许 `:latest`）
   - Phoenix `arizephoenix/phoenix:version-8.0.0`
   - Postgres `postgres:16`
   - Grafana `grafana/grafana:11.0.0`
3. **Port allocation**
   - Phoenix UI / OTLP HTTP collector → host `6006`
   - Phoenix OTLP gRPC collector → host `4317`
   - Phoenix Prometheus-compatible metrics → host `9090`（`PHOENIX_ENABLE_PROMETHEUS=true`，**不**起独立 Prometheus 容器）
   - Grafana UI → host `3001`（**不**用 `3000`，避让 MUAP webhook 默认端口）
   - Postgres → 仅 compose 网络内部
4. **Grafana provisioning**
   - 两个 datasource：`Phoenix Postgres` (PostgreSQL, uid `phoenix-postgres`) + `Phoenix Metrics` (Prometheus, uid `phoenix-metrics`, URL `http://phoenix:9090`)。
   - 一个 file provider：`MUAP Observability Bootstrap`（folder `MUAP Observability`，`allowUiUpdates: false`）。
   - 一个占位 dashboard：`muap-observability-bootstrap.json`，仅含 text panel 说明 "PR-O1 是 bootstrap；host/runner span 与完整 dashboards 留给 PR-O2/O3"。
5. **Read-only datasource policy**
   - Grafana 进 Phoenix Postgres 使用 `grafana_ro` 角色（`init/grafana_readonly.sql` 在 Postgres 首启动时创建）：`NOSUPERUSER NOCREATEDB NOCREATEROLE`，只授予 `CONNECT` / `USAGE` / `SELECT`。
   - 同时给未来表用 `ALTER DEFAULT PRIVILEGES ... GRANT SELECT` 保持只读。
   - Grafana datasource 设 `editable: false`，避免操作员手动改 datasource 漂离 provisioning。
6. **Persistence**
   - 三个 named volume：`muap_phoenix_sim_data`、`muap_phoenix_postgres_data`、`muap_grafana_data`。
   - `pnpm obs:down` 不删卷；`pnpm obs:reset` 删。
7. **Env coordination with Phase 0a**
   - host 端 observability env keys（`PHOENIX_OTLP_ENDPOINT`、`PHOENIX_COLLECTOR_ENDPOINT`、`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`PHOENIX_PROJECT_NAME`、`GRAFANA_HOST_PORT`）由 `scripts/generate-env-local-proposed.ts` 写入 `.env.local.proposed`，遵循 [ADR-0008](ADR-0008-phase0a-lab-frontdesk-onboarding.md) 的人工 review 流程。
   - compose stack 自己的服务凭据走 `infra/observability/.env.example`（local-only 默认值），与 host 端 env 文件分开。
8. **Forbidden imports in PR-O1 scope**
   - 任何 `@opentelemetry/*` 或 `@arizeai/openinference-*` import；`PHOENIX_*` / `OTEL_*` 标识符出现在 runtime 路径——`scripts/observability-bootstrap.test.ts` 守门。
9. **Deferred to later PRs**
   - PR-O2：host instrumentation（OTel SDK init、tracing middleware、request wrappers）。
   - PR-O3：runner instrumentation（manual / hybrid span，遵循 Oracle 对 `@anthropic-ai/claude-agent-sdk` 的 ruling）。
   - 后续 PR：完整业务 dashboards、alerts、SLO、notification channel。

理由（可验证）：

1. **可回滚性**：纯 infra-only commit 一次性 revert 不会回到运行时回归（host/runner 没改）。
2. **Oracle ruling 兼容**：runner observability 已知需要 manual/hybrid span，本 PR 不强行做意味着 PR-O3 可独立决策实现细节。
3. **端口安全**：`3001` vs `3000` 的选择是已知约束（README.md 与 `src/index.ts` 都引用 webhook `3000`）。
4. **Identity 信任链不变**：只读 datasource 角色 + 不动 runtime 代码 = 不可能弱化身份链。

## Consequences

- **Positive**：
  - PR-O2/O3 拿到稳定的 `PHOENIX_OTLP_ENDPOINT` 与 Grafana stack，不需再 re-litigate compose / 端口 / persistence。
  - 一次 `pnpm obs:reset` 可清空所有本地观测数据，对开发循环友好。
  - `scripts/observability-bootstrap.test.ts` 守门，未来 PR 误把 OTel import 塞进 host/runner 会被 CI 拦截。
  - 决策痕迹完整：image pin、端口、provisioning 结构全部写进合同。
- **Negative**：
  - 操作员仍需手工跑一遍 docker QA（`pnpm test` 只能验证文件契约，不能验证容器是否健康启动）；自动化 docker QA 留给后续 PR 处理。
  - 占位 dashboard 没有真实业务面板，对急于看 trace 的用户来说体感有限——这是有意为之，避免把 dashboard 设计与 instrumentation 绑死。
  - Postgres init script (`init/grafana_readonly.sql`) 只在首启动时执行；如果操作员需要改读角色权限，必须 `pnpm obs:reset` 销毁数据卷后重启（runbook 已记录）。
- **Neutral / Trade-offs**：
  - 不起独立 Prometheus 容器换来配置面收敛；如果将来需要更细的 metrics 视图（自定义抓取间隔、外部 exporter），仍可在 PR-Ox 阶段补一个 Prometheus 服务，本 ADR 不锁死这一点。
  - 用 `:version-8.0.0` 而不是 `:latest`：拿一致性换升级成本；后续要升 Phoenix 版本需要单独 ADR 或在本 ADR 后追加 addendum。
  - Grafana 强制登录（`GF_AUTH_ANONYMOUS_ENABLED=false`）牺牲了"打开就看"的便捷度，换来对生产/演示环境一致的安全姿态。

## Implementation Notes

- **文件清单**（PR-O1 commit 范围）：
  - `infra/observability/docker-compose.sim.yml`
  - `infra/observability/docker-compose.prod.yml`
  - `infra/observability/init/grafana_readonly.sql`
  - `infra/observability/grafana/provisioning/datasources/phoenix-postgres.yml`
  - `infra/observability/grafana/provisioning/dashboards/dashboards.yml`
  - `infra/observability/grafana/dashboards/muap-observability-bootstrap.json`
  - `infra/observability/.env.example`
  - `infra/observability/README.md`（runbook，详见 Phase 0b PR-O1 plan Step 8）
  - `scripts/observability-bootstrap.test.ts`（artifact 合同测试，TDD RED → GREEN）
  - `scripts/generate-env-local-proposed.ts` 与 `scripts/generate-env-local-proposed.test.ts`（扩展 observability 段；保留 Phase 0a 行为）
  - `package.json` 新增 `obs:up` / `obs:up:prod` / `obs:up:sim` / `obs:down` / `obs:down:sim` / `obs:logs` / `obs:config` / `obs:reset` 八个脚本
  - `docs/decisions/ADR-0009-observability-bootstrap-contract.md`（本文件）
  - `docs/decisions/README.md`（索引追加一行）
- **不能改的文件**：`src/index.ts`、`src/router.ts`、`src/delivery.ts`、`src/host-sweep.ts`、`src/container-runner.ts`、`container/agent-runner/src/*`、姊妹仓 `openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example`。
- **测试守门**：`scripts/observability-bootstrap.test.ts` 涵盖 6 个契约（artifact 路径存在、image pin、`obs:*` 脚本、env 提案 keys、ADR + 索引、host/runner 不引入 telemetry import）。
- **TDD 顺序**：先写测试（RED），再写 infra，再补 runbook + ADR + 索引，最后跑 `pnpm typecheck && pnpm test && pnpm lint`，达成 GREEN。
- **manual QA handoff**：runbook (`infra/observability/README.md` §首次启动检查清单) 是 PR-O1 的最后一道闸门；自动化测试不会真启动 docker，需运维人员手工验证 Phoenix UI、Grafana health、datasource、占位 dashboard。

## References

- 上游宪法：[`../../../openclaw/CLOSEOUT/migration-to-muap.md`](../../../openclaw/CLOSEOUT/migration-to-muap.md)（v1.2，Phase 0b binding）
- 上游设计：[`../../../openclaw/CLOSEOUT/agent-observability-design.md`](../../../openclaw/CLOSEOUT/agent-observability-design.md)
- 姊妹模板（只读）：[`../../../openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example`](../../../openclaw/CLOSEOUT/phase0-implementation-pack/env-template.example)
- 上游 ADR：
  - [ADR-0006](ADR-0006-phase0b-parallel-observability.md)（Phase 0b 与 Phase 0a 并行）
  - [ADR-0007](ADR-0007-observability-phoenix-grafana.md)（Phoenix + Grafana 选型）
  - [ADR-0008](ADR-0008-phase0a-lab-frontdesk-onboarding.md)（Phase 0a 落地 + env 流程）
- 落地计划：[`../../.sisyphus/plans/phase0b-pr-o1-observability-bootstrap.md`](../../.sisyphus/plans/phase0b-pr-o1-observability-bootstrap.md)（10 步 / 4 wave；Momus reviewed [OKAY]）
- 守门测试：[`../../scripts/observability-bootstrap.test.ts`](../../scripts/observability-bootstrap.test.ts)
- Runbook：[`../../infra/observability/README.md`](../../infra/observability/README.md)

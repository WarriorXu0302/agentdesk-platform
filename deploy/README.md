# Deploy templates

The host is a single Node process (see `docs/architecture.md`). The platform
deliberately does **not** ship an opinionated, hardcoded process unit — run-as
user, absolute paths, and env are deployment-specific. These are **templates**;
fill the `<PLACEHOLDERS>` and install with your process manager.

| File | Use |
|---|---|
| [`systemd/agentdesk.service`](systemd/agentdesk.service) | Linux production host (auto-restart, graceful-stop headroom, light hardening) |
| [`launchd/com.agentdesk.host.plist`](launchd/com.agentdesk.host.plist) | macOS dev / single-box |

Both expect a built host (`pnpm build`) and a `.env` (see [`.env.example`](../.env.example)).

## Operator checklist before production

This baseline is a **single-host, single-process** platform. The code is
production-ready for that shape; these are the "last mile" steps the platform
delegates to you (see the production-readiness section of `docs/RUNBOOK.md`):

1. **Process supervision** — install one of the units above so a crash
   auto-recovers. `/healthz` (liveness) + `/readyz` (DB + container runtime) are
   on `WEBHOOK_PORT`.
2. **Egress lockdown** — the agent container's network is unrestricted by
   default. Point `AGENT_CONTAINER_NETWORK` (or per-group `network`) at an
   egress-proxy/allowlist network so a leaked in-container key can't exfiltrate.
   See [`docs/security/container-egress.md`](../docs/security/container-egress.md).
3. **Backups** — schedule [`scripts/backup.sh`](../scripts/backup.sh) (cron
   example in its header); it snapshots `v2.db` **and** every session DB. Set
   your RPO by run frequency.
4. **Monitoring** — bring up the observability stack (`pnpm obs:up`) and wire
   Alertmanager to your pager. Alert rules ship in
   `infra/observability/prometheus/alerts.yml`.
5. **Secrets** — never the `.env.example` placeholders (startup rejects known
   weak values); rotate Feishu / gateway signing keys per your policy.
6. **Identity** — keep roster-DM-enabled groups on `a2aSessionMode=root-session`
   (the configure script's default) to avoid shared-worker identity mixing.

#!/usr/bin/env bash
#
# quickstart.sh — one-shot local setup for AgentDesk (roadmap 1.1).
#
# Goes from a fresh clone to a working frontdesk → worker topology with the
# orchestration steps run IN ORDER, so you don't have to reverse-engineer them
# from the README. The deterministic, business-agnostic steps are automated
# (deps, image, topology); the two steps that need YOUR specifics — pointing the
# backend gateway at your HTTP service, and wiring a real chat channel's
# credentials — are printed as clear next steps at the end (they can't be
# guessed).
#
# Usage:
#   ./quickstart.sh                      # full run (install + build + init)
#   QUICKSTART_WORKERS=a,b ./quickstart.sh   # custom demo worker folders
#   ./quickstart.sh --skip-build         # re-run without rebuilding the image
#
# Idempotent enough to re-run: pnpm install / init:enterprise reuse existing
# state rather than clobbering hand-tuned values.
set -euo pipefail
cd "$(dirname "$0")"

WORKERS="${QUICKSTART_WORKERS:-research-worker,ops-worker}"
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg (see --help)" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }

step "1/4  Installing host dependencies (pnpm)…"
pnpm install

if [ "$SKIP_BUILD" -eq 1 ]; then
  step "2/4  Skipping container image build (--skip-build)."
else
  step "2/4  Building the agent container image (needs Docker running)…"
  pnpm container:build
fi

step "3/4  Initializing an enterprise topology (a frontdesk + demo workers: ${WORKERS})…"
pnpm init:enterprise --workers "${WORKERS}"

step "4/4  Local setup done. Two steps remain that need YOUR specifics:"
cat <<EOF

  a) Point the backend gateway at your HTTP service (the ONLY path for business
     memory + authorization). For a fully-local demo you can run the zero-dep
     reference backend and point at it:

       node examples/reference-gateway/server.mjs          # terminal A (:8088)
       pnpm configure:enterprise-gateway --base-url http://localhost:8088 \\
         --folders <frontdesk-folder>[,<worker-folder>,...]

     For production, swap the URL for your own gateway (see docs/enterprise-erp-gateway.md).

  b) Wire a chat channel. The built-in CLI channel needs no credentials — great
     for a first run. For Feishu, set the creds in .env (see .env.example +
     docs/feishu-channel.md).

  Then start the host and talk to it:

       pnpm dev            # terminal B — starts the host
       pnpm chat           # terminal C — chat via the local CLI channel

  Full picture: README.md + docs/PLATFORM.md (architecture diagram up top).
EOF

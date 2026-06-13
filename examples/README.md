# Examples

Worked reference setups that show how to put a real business on top of the
platform. **None of this is loaded by default** — the baseline ships a single
blank template frontdesk and no workers. These directories are here to copy
from, not to run as-is.

## How a group folder becomes a live agent

Agent group working directories live under `groups/` at runtime and are
created by the bootstrap script (`scripts/init-enterprise-topology.ts`) or by
an admin agent. An example here is just a `groups/<folder>/` payload you can
copy in:

```bash
# 1. Copy an example into your live groups dir under whatever folder name you want
cp -r examples/lab-frontdesk groups/my-frontdesk

# 2. Register it + wire a channel (see the init script header for all flags)
pnpm exec tsx scripts/init-enterprise-topology.ts \
  --frontdesk-folder my-frontdesk \
  --frontdesk-name "My Front Desk" \
  --channel feishu --platform-id <chat-id>

# 3. Point it at your backend gateway
pnpm exec tsx scripts/configure-enterprise-gateway.ts \
  --base-url https://your-gateway.example.com/api/agent \
  --folders my-frontdesk
```

## What's here

| Example | What it demonstrates |
|---|---|
| [`lab-frontdesk/`](lab-frontdesk/) | A self-contained frontdesk that talks to a backend gateway directly (no worker pool). Originally a lab-automation assistant; a good template for a single-desk deployment with a rich domain prompt. |
| [`echo-channel/`](echo-channel/) | A **fork-free channel extension** (ADR-0031): a minimal in-memory channel adapter you drop into `EXTENSIONS_DIR` to add a channel without forking the repo. See also `docs/channels/writing-a-channel.md`. |

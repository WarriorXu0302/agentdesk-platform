# Writing a channel — without forking the platform

There are two ways to add a channel (Slack, Discord, WhatsApp, your own
internal chat system, …) to the platform:

1. **In-tree** — copy a channel module into `src/channels/`, append a
   self-registration import in `src/channels/index.ts`, and rebuild. This is
   what the `/add-slack`-style channel skills do; it requires editing the repo.
2. **Fork-free** *(this doc)* — ship a directory with a `manifest.json` + an
   entry module, drop it into your `EXTENSIONS_DIR`, and the host loads it at
   startup. **No change to the platform repo.** This is the recommended path
   for third parties and operator-specific channels (ADR-0031).

Both paths converge on the same `ChannelAdapter` contract
(`src/channels/adapter.ts`) and the same structural gate
(`assertChannelAdapterContract`, ADR-0030). A fork-free extension is loaded,
version-checked, and contract-checked, then `setup()` by `initChannelAdapters`
exactly like a built-in.

A complete worked example lives at [`examples/echo-channel/`](../../examples/echo-channel/).

---

## 1. Implement the `ChannelAdapter` contract

Your adapter is a plain object satisfying `ChannelAdapter`
(`src/channels/adapter.ts`). Required surface:

| member | type | meaning |
|---|---|---|
| `name` | non-empty string | adapter name (logs) |
| `channelType` | non-empty string | the channel type — must match your manifest's `channelType` |
| `supportsThreads` | boolean | does the platform model conversations as threads? |
| `setup(config)` | `Promise<void>` | bind sockets/webhooks; call `config.onInbound(...)` on inbound messages |
| `teardown()` | `Promise<void>` | release resources |
| `isConnected()` | boolean | health probe |
| `deliver(platformId, threadId, message)` | `Promise<string \| undefined>` | send an outbound message; return the platform message id if any |

Optional methods (`setTyping`, `syncConversations`, `resolveChannelName`,
`isMember`, `subscribe`, `openDM`) — if you implement them, they must be
functions. Omit the ones you don't support.

Inbound flows in via the `ChannelSetup` callbacks the host passes to `setup()`:
`onInbound` (normal chat), `onInboundEvent` (admin transport), `onMetadata`,
`onAction`. See the in-tree `cli` adapter (`src/channels/cli.ts`) for a small,
complete reference.

## 2. Self-register on import

Your entry module must call `registerChannelAdapter` **on import** — the loader
imports the entry for its side effect, then looks for the new registration.
This is the same pattern the in-tree modules use:

```ts
import { registerChannelAdapter } from 'agentdesk-platform/dist/channels/channel-registry.js';

function createMyAdapter() {
  return {
    name: 'my-chat',
    channelType: 'my-chat',
    supportsThreads: true,
    async setup(config) { /* … */ },
    async teardown() {},
    isConnected() { return true; },
    async deliver(platformId, threadId, message) { /* … */ return undefined; },
  };
}

registerChannelAdapter('my-chat', { factory: createMyAdapter });
```

The factory may return `null` if its credentials are missing — the host logs
and skips it at `initChannelAdapters` time, same as a built-in.

> **Resolving the import.** Your entry runs inside the host's Node process, so
> the `registerChannelAdapter` import must resolve to the **installed**
> platform's `dist/channels/channel-registry.js`. Wire it with a `file:`
> dependency on the platform checkout, a relative path, or a path alias — see
> `examples/echo-channel/README.md`.

## 3. Write the manifest

`manifest.json`, next to your entry:

```jsonc
{
  "id": "my-chat",              // stable id (logs / dedupe)
  "kind": "channel",            // only "channel" today
  "name": "My Chat",
  "channelType": "my-chat",     // MUST equal the adapter's channelType
  "capabilities": ["text"],     // optional, advisory only
  "minHostVersion": "^2.0.0",   // host version gate (see below)
  "entry": "./index.js"         // entry module, relative to this dir; no `..`
}
```

A malformed manifest, a missing entry, or a `..`-traversing entry is logged and
skipped — it never crashes host startup.

### Version compatibility — `minHostVersion`

The host gates your extension against its own version (from the platform's
`package.json`). `minHostVersion` is a **small** semver range:

| form | example | satisfied when |
|---|---|---|
| exact | `2.0.44` | host == 2.0.44 |
| caret | `^2.0.0` | host major == 2 and host >= 2.0.0 |
| tilde | `~2.0.0` | host 2.0.x and >= 2.0.0 |
| gte | `>=2.0.0` | host >= 2.0.0 |
| wildcard | `*` | any host |

If the host doesn't satisfy the range, the loader `log.warn`s and **skips** the
extension without importing it — so a mismatched extension can't pull in code
that expects a host API it doesn't have. (The matcher is a minimal inline
implementation in `src/channels/semver-range.ts`; richer ranges aren't
supported.)

## 4. Self-test with `assertChannelAdapterContract`

The platform publishes `assertChannelAdapterContract` as a reusable asset
(`src/channels/channel-contract.ts`). It's the SAME structural gate the host
applies at load time, so test against it before you ship:

```ts
import { assertChannelAdapterContract } from 'agentdesk-platform/dist/channels/channel-contract.js';
import { createMyAdapter } from './index.js';

assertChannelAdapterContract(createMyAdapter()); // throws on any violation
```

A non-conforming adapter (e.g. `deliver` isn't a function) is **unregistered
and skipped** by the host at load time — green here means the host won't reject
you on structural grounds. TypeScript already checks call signatures; this
guards the runtime shape (useful for JS adapters or loosely-typed builds).

## 5. Install — drop it into `EXTENSIONS_DIR`

```bash
# EXTENSIONS_DIR defaults to ~/.config/<brand-namespace>/extensions
# (the namespace comes from BRAND_NAMESPACE; default "agentdesk").
# Override with the EXTENSIONS_DIR env var.
mkdir -p ~/.config/agentdesk/extensions
cp -r my-chat-extension ~/.config/agentdesk/extensions/my-chat
```

Start the host. You'll see `Channel extension loaded ... channelType=my-chat`
in the logs, and the channel is now `setup()`-ready exactly like a built-in.
Nothing loads unless `EXTENSIONS_DIR` exists and contains your directory, so
adding the feature doesn't affect installs that don't use it.

---

## Trust model — read this

`EXTENSIONS_DIR` is **operator-controlled**. Loading code from it is no
different from the operator editing the platform repo: the extension runs **in
the host process** with full host privileges. There is **no signing, no
registry, and no marketplace** — this is deliberately *not* a public plugin
hub. Only put extensions you trust into `EXTENSIONS_DIR`. The version gate and
contract gate are compatibility/structural guards, **not** a security boundary.
See ADR-0031 for the full rationale.

## What the loader does, in order

For each subdirectory of `EXTENSIONS_DIR`:

1. read + parse `manifest.json` (skip on parse error),
2. version gate: host must satisfy `minHostVersion` (else skip),
3. dynamic-import the entry — it self-registers via `registerChannelAdapter`,
4. contract gate: instantiate the new factory and run
   `assertChannelAdapterContract`; on violation, **unregister** it and skip,
5. fail-open: any error skips just that one extension — never the host.

Then `initChannelAdapters` sets up every registered adapter — built-in and
extension — identically.

## Related

- `src/channels/adapter.ts` — the `ChannelAdapter` contract
- `src/channels/channel-contract.ts` — `assertChannelAdapterContract`
- `src/channels/extension-manifest.ts` — manifest shape + parser
- `src/channels/extension-loader.ts` — the loader
- `examples/echo-channel/` — a runnable minimal example
- `docs/decisions/ADR-0030-channel-contract-testing.md` — the contract gate
- `docs/decisions/ADR-0031-fork-free-channel-extensions.md` — this feature
- `docs/feishu-channel.md` — a full in-tree channel for reference

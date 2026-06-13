# echo-channel — a fork-free channel extension example

This directory is a complete, minimal **channel extension**: a third party can
add a new channel to the platform **without forking the main repo**. Drop the
directory into your `EXTENSIONS_DIR` and the host loads it at startup alongside
the in-tree `cli` / `feishu` channels (see ADR-0031).

The `echo` channel is in-memory: whatever the agent sends out, it feeds straight
back in as a new inbound message. No credentials, no external service — just
enough to exercise the host's `inbound → route → deliver` path.

## What's in here

| File | Purpose |
|---|---|
| `manifest.json` | The extension manifest the host reads first (see below). |
| `index.ts` | The adapter implementation + self-registration. Compile to `index.js` (the `entry`). |
| `index.selftest.ts` | Demonstrates importing `assertChannelAdapterContract` to self-test the adapter. |

## The manifest

```jsonc
{
  "id": "echo-channel",          // stable id, used in logs
  "kind": "channel",             // only "channel" is supported today
  "name": "Echo Channel (example)",
  "channelType": "echo",         // MUST match the adapter's channelType
  "capabilities": ["text"],      // advisory only
  "minHostVersion": "^2.0.0",    // host version gate (small semver range)
  "entry": "./index.js"          // entry module, relative to this dir
}
```

The loader:

1. parses `manifest.json` (a malformed manifest is logged and skipped — it never
   crashes host startup),
2. checks the host version satisfies `minHostVersion` (else skip),
3. dynamic-imports `entry`, which **self-registers** via `registerChannelAdapter`,
4. runs the freshly-registered adapter through `assertChannelAdapterContract`;
   a non-conforming adapter is unregistered and skipped,
5. and on success hands it to `initChannelAdapters`, which `setup()`s it like a
   built-in.

## Install it (no fork required)

```bash
# EXTENSIONS_DIR defaults to ~/.config/<brand-namespace>/extensions
# (override with the EXTENSIONS_DIR env var).
mkdir -p ~/.config/agentdesk/extensions

# Build your entry (index.ts → index.js) however you package it, then copy the dir:
cp -r examples/echo-channel ~/.config/agentdesk/extensions/echo-channel

# Start the host — the loader logs "Channel extension loaded ... channelType=echo".
```

No change to the platform repo. Nothing is loaded unless `EXTENSIONS_DIR` exists
and contains your directory, so existing installs are unaffected.

## Resolving the platform imports

Your entry needs two symbols from the **installed** platform:

- `registerChannelAdapter` — to self-register (required), and
- `assertChannelAdapterContract` — to self-test (recommended).

The host runs your `index.js` inside its own Node process, so your import
specifiers must resolve to the running platform's compiled channel modules
(`dist/channels/channel-registry.js` and `dist/channels/channel-contract.js`).
Pick whichever packaging fits your setup:

- a `file:` dependency on the platform checkout, then
  `import { registerChannelAdapter } from 'agentdesk-platform/dist/channels/channel-registry.js'`
  (the platform's `package.json` name is `agentdesk-platform`), **or**
- a relative path from where you drop the extension to the platform's `dist/`, **or**
- a TS path alias if you build with the platform's types in scope.

For readability, the `index.ts` / `index.selftest.ts` in this directory use the
**in-repo relative path** (`../../src/channels/...`) so they type-check and run
when developed *inside* a checkout of the platform. An out-of-tree author swaps
the specifier for their install path.

## Self-test before you ship

```bash
pnpm exec tsx examples/echo-channel/index.selftest.ts
# → echo-channel: assertChannelAdapterContract passed ✓
```

A passing `assertChannelAdapterContract` is the **same** structural gate the
host applies at load time — so green here means the host won't reject your
adapter on structural grounds. See `docs/channels/writing-a-channel.md` for the
full walkthrough.

// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Main ships with two built-in channels:
//   - `cli`    — the always-on local-terminal channel
//   - `feishu` — env-configured enterprise event adapter (webhook / long-connection)
//
// Other channel skills (/add-slack, /add-discord, /add-whatsapp, ...) copy
// their module from the `channels` branch and append a self-registration
// import below.
//
// Third parties can ALSO add a channel WITHOUT forking this repo: drop a
// `manifest.json` + entry module into `EXTENSIONS_DIR` and the host loads it
// at startup via `loadChannelExtensions()` (ADR-0031). The entry module
// self-registers with `registerChannelAdapter` exactly like the modules below,
// then passes the same `assertChannelAdapterContract` gate. See
// `docs/channels/writing-a-channel.md`.

import './cli.js';
import './feishu.js';

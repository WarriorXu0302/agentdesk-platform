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

import './cli.js';
import './feishu.js';

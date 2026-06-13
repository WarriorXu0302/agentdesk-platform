/**
 * Echo channel — a minimal fork-free channel extension (ADR-0031).
 *
 * This file is what the platform's extension loader dynamic-imports. On import
 * it self-registers an adapter via `registerChannelAdapter`, exactly like the
 * in-tree `cli`/`feishu` modules. The loader then runs the adapter through
 * `assertChannelAdapterContract` before `initChannelAdapters` sets it up.
 *
 * To install: compile this to `index.js` (the manifest's `entry`) and drop the
 * whole directory into your `EXTENSIONS_DIR`. No fork of the platform repo.
 *
 * --- Resolving the platform imports ---
 * An out-of-tree extension imports the two platform symbols it needs
 * (`registerChannelAdapter` and, for self-testing, `assertChannelAdapterContract`)
 * from the INSTALLED platform. The host runs your entry inside its own Node
 * process, so point these imports at the platform's compiled channel modules.
 * Concretely, in your built `index.js`, the import specifier should resolve to
 * the running platform's `dist/channels/channel-registry.js`. How you wire that
 * is a packaging choice (a path alias, a `file:` dependency on the platform, or
 * a relative path from where you drop the extension). See README.md.
 *
 * For readability this source uses the in-repo relative path so it type-checks
 * and self-tests when developed *inside* a checkout of the platform; a real
 * out-of-tree author swaps the specifier for their install's path.
 */
import type {
  ChannelAdapter,
  ChannelSetup,
  OutboundMessage,
} from '../../src/channels/adapter.js';
import { registerChannelAdapter } from '../../src/channels/channel-registry.js';

const CHANNEL_TYPE = 'echo';

/**
 * Build the echo adapter. In-memory only: it keeps the last setup config and
 * "delivers" by echoing the outbound text back through `onInbound`, which is
 * enough to exercise the host's inbound→route→deliver path end to end without
 * any external service or credentials.
 */
export function createEchoAdapter(): ChannelAdapter {
  let config: ChannelSetup | null = null;

  const adapter: ChannelAdapter = {
    name: 'echo',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      config = cfg;
    },

    async teardown(): Promise<void> {
      config = null;
    },

    isConnected(): boolean {
      return config !== null;
    },

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      const text = extractText(message);
      if (text === null) return undefined;
      // Echo: feed the outbound text straight back in as a new inbound message.
      // A real adapter would call its platform's send API here instead.
      if (config) {
        await config.onInbound(platformId, threadId, {
          id: `echo-${Date.now()}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: { text: `echo: ${text}`, sender: 'echo', senderId: `echo:${platformId}` },
        });
      }
      return undefined;
    },
  };

  return adapter;
}

function extractText(message: OutboundMessage): string | null {
  const content = message.content as Record<string, unknown> | string | undefined;
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && typeof content.text === 'string') return content.text;
  return null;
}

// Self-register on import — this is the line the loader relies on.
registerChannelAdapter('echo', { factory: createEchoAdapter });

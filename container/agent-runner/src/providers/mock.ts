import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

/**
 * Mock provider for testing. Returns canned responses.
 * Supports push() — queued messages produce additional results.
 */
export class MockProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private responseFactory: (prompt: string) => string;

  constructor(_options: ProviderOptions = {}, responseFactory?: (prompt: string) => string) {
    this.responseFactory = responseFactory ?? ((prompt) => `Mock response to: ${prompt.slice(0, 100)}`);
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const pending: string[] = [];
    // Stream-reanchor reminders are buffered and folded into the NEXT real
    // pushed message so they reach the next turn without producing their own
    // result event (mirrors the OpenAI provider's no-extra-turn semantics).
    const pendingReminders: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;
    const responseFactory = this.responseFactory;

    const events: AsyncIterable<ProviderEvent> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'activity' };
        yield { type: 'init', continuation: `mock-session-${Date.now()}` };

        // Process initial prompt
        yield { type: 'activity' };
        yield { type: 'result', text: responseFactory(input.prompt) };

        // Process any pushed follow-ups
        while (!ended && !aborted) {
          if (pending.length > 0) {
            const msg = pending.shift()!;
            yield { type: 'result', text: responseFactory(msg) };
            continue;
          }
          // Wait for push() or end()
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        // Drain remaining
        while (pending.length > 0) {
          const msg = pending.shift()!;
          yield { type: 'result', text: responseFactory(msg) };
        }
      },
    };

    return {
      push(message: string) {
        const prefix = pendingReminders.length > 0 ? `${pendingReminders.join('\n')}\n` : '';
        pendingReminders.length = 0;
        pending.push(`${prefix}${message}`);
        waiting?.();
      },
      pushSystemReminder(text: string) {
        // Buffer only — no result is produced for a reminder on its own.
        pendingReminders.push(text);
      },
      end() {
        ended = true;
        waiting?.();
      },
      events,
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('mock', (opts) => new MockProvider(opts));

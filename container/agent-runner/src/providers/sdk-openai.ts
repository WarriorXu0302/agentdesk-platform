import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { registerProvider } from './provider-registry.js';
import type { AgentProvider, AgentQuery, ProviderEvent, ProviderOptions, QueryInput } from './types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o';

class SdkOpenAIProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;

  private baseURL: string;
  private apiKey: string;
  private model: string;

  constructor(options: ProviderOptions = {}) {
    const env = options.env ?? {};
    this.baseURL = env.OPENAI_BASE_URL ?? DEFAULT_BASE_URL;
    this.apiKey = env.OPENAI_API_KEY ?? '';
    this.model = env.OPENAI_MODEL ?? DEFAULT_MODEL;
  }

  isSessionInvalid(_err: unknown): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    const self = this;
    const pending: string[] = [];
    let waiting: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    async function* run(): AsyncGenerator<ProviderEvent> {
      if (!self.apiKey) {
        throw new Error('OPENAI_API_KEY is missing for provider=sdk-openai');
      }

      const provider = createOpenAICompatible({
        name: 'sdk-openai',
        baseURL: self.baseURL,
        apiKey: self.apiKey,
      });

      let currentPrompt = input.prompt;

      while (!ended && !aborted) {
        yield { type: 'activity' };

        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
        if (input.systemContext?.instructions) {
          messages.push({ role: 'system', content: input.systemContext.instructions });
        }
        messages.push({ role: 'user', content: currentPrompt });

        const startMs = Date.now();
        const result = await generateText({
          model: provider.languageModel(self.model),
          messages,
        });
        const durationMs = Date.now() - startMs;

        yield { type: 'init', continuation: `sdk-${Date.now()}` };
        yield { type: 'activity' };

        if (result.text) {
          yield { type: 'result', text: result.text };
        }

        if (result.usage) {
          yield {
            type: 'usage',
            model: self.model,
            inputTokens: result.usage.promptTokens,
            outputTokens: result.usage.completionTokens,
            totalTokens: result.usage.totalTokens,
            durationMs,
            transport: 'chat-completions',
          };
        }

        // Wait for follow-up messages or end signal
        while (!ended && pending.length === 0) {
          await new Promise<void>((resolve) => {
            waiting = resolve;
          });
          waiting = null;
        }

        if (pending.length > 0) {
          currentPrompt = pending.shift()!;
        }
      }

      // Drain remaining
      while (pending.length > 0) {
        yield { type: 'result', text: pending.shift()! };
      }
    }

    return {
      push(message: string) {
        pending.push(message);
        waiting?.();
      },
      end() {
        ended = true;
        waiting?.();
      },
      events: run(),
      abort() {
        aborted = true;
        waiting?.();
      },
    };
  }
}

registerProvider('sdk-openai', (opts) => new SdkOpenAIProvider(opts));

export interface AgentProvider {
  /**
   * True if the provider's underlying SDK handles slash commands natively and
   * wants them passed through as raw text. When false, the poll-loop formats
   * slash commands like any other chat message.
   */
  readonly supportsNativeSlashCommands: boolean;

  /** Start a new query. Returns a handle for streaming input and output. */
  query(input: QueryInput): AgentQuery;

  /**
   * True if the given error indicates the stored continuation is invalid
   * (missing transcript, unknown session, etc.) and should be cleared.
   */
  isSessionInvalid(err: unknown): boolean;
}

/**
 * Options passed to provider constructors. Fields are common to most
 * providers; individual providers may ignore any they don't need.
 */
export interface ProviderOptions {
  assistantName?: string;
  mcpServers?: Record<string, McpServerConfig>;
  env?: Record<string, string | undefined>;
  additionalDirectories?: string[];
}

export interface QueryInput {
  /** Initial prompt (already formatted by agent-runner). */
  prompt: string;

  /**
   * Opaque continuation token from a previous query. The provider decides
   * what this means (session ID, thread ID, nothing at all).
   */
  continuation?: string;

  /** Working directory inside the container. */
  cwd: string;

  /**
   * System context to inject. Providers translate this into whatever their
   * SDK expects (preset append, full system prompt, per-turn injection…).
   */
  systemContext?: {
    instructions?: string;
  };
}

export interface McpServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface AgentQuery {
  /** Push a follow-up message into the active query. */
  push(message: string): void;

  /**
   * Inject a stream-reanchor system reminder that must reach the NEXT real
   * LLM turn's transcript WITHOUT itself triggering a fresh turn / LLM call.
   *
   * This exists to distinguish "in-stream reanchor" from "new user turn".
   * `push` is for genuine new user input — providers that model turns as
   * discrete stateless requests (OpenAI) re-run a full `runTurn` (a real LLM
   * call) when pushed. The post-compaction destination reminder
   * (poll-loop.ts, `compacted` event) is NOT new user input — it must not
   * cost an extra round trip. `pushSystemReminder` lets such providers fold
   * the reminder into the next real turn's input instead of spending a turn
   * on it now.
   *
   * Contract:
   *   - The reminder MUST be visible to the model on the next real turn
   *     (so destination routing re-anchors after compaction).
   *   - The call MUST NOT trigger an additional LLM call by itself.
   *
   * Providers whose `push` already injects into a live streamed turn without
   * a wasted round trip (Claude) MAY implement this as an alias of `push`.
   */
  pushSystemReminder(text: string): void;

  /** Signal that no more input will be sent. */
  end(): void;

  /** Output event stream. */
  events: AsyncIterable<ProviderEvent>;

  /** Force-stop the query. */
  abort(): void;
}

export type ProviderEvent =
  | { type: 'init'; continuation: string }
  | { type: 'result'; text: string | null }
  | { type: 'error'; message: string; retryable: boolean; classification?: string }
  | { type: 'progress'; message: string }
  /**
   * Liveness signal. Providers MUST yield this on every underlying SDK
   * event (tool call, thinking, partial message, anything) so the
   * poll-loop's idle timer stays honest during long tool runs.
   */
  | { type: 'activity' }
  /**
   * The provider's underlying SDK auto-compacted the conversation context.
   * The poll-loop reacts by injecting a destination reminder back into
   * the live query so the agent doesn't drop `<message to="…">` wrapping
   * after compaction. Distinct from `result` so it doesn't mark the turn
   * completed or get dispatched as a chat message. See qwibitai/nanoclaw#2325.
   *
   * `summary` (optional): the actual compaction summary text, when the provider
   * can surface it (ADR-0041, roadmap 4.1). The poll-loop fire-and-forgets it to
   * durable gateway memory (conversation.summary) so the agent can recall what
   * was compacted away. `text` stays the human-readable status line. Providers
   * that can't expose a summary (e.g. Claude's SDK exposes only token counts)
   * omit it and the flush is a no-op — no fabricated summary is ever written.
   */
  | { type: 'compacted'; text: string; summary?: string }
  /**
   * Per-LLM-call usage report. Emitted after each successful API call so the
   * poll-loop can record cost/latency to outbound.db (kind='llm-usage') and
   * downstream observability (Langfuse sidecar) can attribute LLM cost back
   * to the originating turn. Optional — providers that don't expose usage
   * metadata simply skip the event.
   *
   * `inputMessages` / `outputText` are the FULL-PLAINTEXT message content of
   * this LLM call (ADR-0027). They are populated by the provider ONLY when
   * content capture is enabled (`captureContentEnabled()`); otherwise they are
   * left undefined and the provider.request span stays metadata-only. The
   * poll-loop writes them onto the span as OpenInference `llm.input_messages.*`
   * / `output.value`, never to outbound.db. Keeping them on the optional usage
   * event (instead of building a second span deep in the provider) preserves
   * the one-span-per-usage-event invariant from ADR-0026.
   */
  | {
      type: 'usage';
      model: string;
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      durationMs?: number;
      transport?: string;
      inputMessages?: LlmMessage[];
      outputText?: string;
    };

/**
 * A single role+content message for LLM input/output content capture
 * (ADR-0027). Content is verbatim plaintext; the poll-loop caps each value for
 * export safety only.
 */
export interface LlmMessage {
  role: string;
  content: string;
}

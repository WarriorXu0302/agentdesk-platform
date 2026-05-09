/**
 * Per-turn request context.
 *
 * Set by the poll loop at the start of each batch, read by MCP tool
 * handlers that need to attribute actions to a real user (e.g. ERP
 * gateway). Using a module-level ref is safe here because the poll loop
 * is strictly sequential: one batch finishes (and we clear the context)
 * before the next starts.
 *
 * This replaces the earlier approach of having every tool call re-read
 * the most recent inbound row — which races with concurrent messages
 * in group/shared sessions, because "most recent" keeps shifting while
 * the prompt is still being processed.
 */

export interface RequestIdentity {
  /** Namespaced user id (e.g. "feishu:ou_xxx"). May be null for scheduled tasks. */
  userId: string | null;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
  /**
   * Was this resolved from trusted host-written fields (senderId /
   * origin_user_id on the inbound row), or from whatever the agent
   * asserted? Propagated into gateway requests as `requesterSource`.
   */
  source: 'session' | 'agent-asserted';
}

let _current: RequestIdentity | null = null;

export function setRequestIdentity(identity: RequestIdentity | null): void {
  _current = identity;
}

export function getRequestIdentity(): RequestIdentity | null {
  return _current;
}

export function clearRequestIdentity(): void {
  _current = null;
}

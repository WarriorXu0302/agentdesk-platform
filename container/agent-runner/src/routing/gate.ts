import { getOutboundDb } from '../db/connection.js';
import type { RoutingAction } from './index.js';

const ROUTING_GATE_KEY = 'routing:active_gate';

export interface RoutingGate {
  decisionId: string;
  anchorId: string;
  action: RoutingAction;
  targetAgentGroupId?: string;
  originChannelType?: string;
  originPlatformId?: string;
  originThreadId?: string | null;
}

export function setRoutingGate(gate: RoutingGate): void {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run(ROUTING_GATE_KEY, JSON.stringify(gate), new Date().toISOString());
}

export function getRoutingGate(): RoutingGate | undefined {
  const row = getOutboundDb().prepare('SELECT value FROM session_state WHERE key = ?').get(ROUTING_GATE_KEY) as
    | { value: string }
    | undefined;
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.value) as Partial<RoutingGate>;
    if (
      typeof parsed.decisionId !== 'string' ||
      typeof parsed.anchorId !== 'string' ||
      (parsed.originChannelType !== undefined && typeof parsed.originChannelType !== 'string') ||
      (parsed.originPlatformId !== undefined && typeof parsed.originPlatformId !== 'string') ||
      (parsed.originThreadId !== undefined &&
        parsed.originThreadId !== null &&
        typeof parsed.originThreadId !== 'string') ||
      !['delegate', 'answer_self', 'clarify', 'reject'].includes(parsed.action ?? '')
    ) {
      return undefined;
    }
    return parsed as RoutingGate;
  } catch {
    return undefined;
  }
}

export function clearRoutingGate(): void {
  getOutboundDb().prepare('DELETE FROM session_state WHERE key = ?').run(ROUTING_GATE_KEY);
}

export function enforceRoutingDestination(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
  threadId?: string | null,
): { allowed: true; decisionId?: string } | { allowed: false; decisionId: string; reason: string } {
  const gate = getRoutingGate();
  if (!gate) return { allowed: true };
  if (channelType !== 'agent') {
    if (
      gate.originChannelType &&
      gate.originPlatformId &&
      (channelType !== gate.originChannelType ||
        platformId !== gate.originPlatformId ||
        (gate.originThreadId !== undefined && (threadId ?? null) !== gate.originThreadId))
    ) {
      return {
        allowed: false,
        decisionId: gate.decisionId,
        reason: 'non_origin_destination',
      };
    }
    return { allowed: true, decisionId: gate.decisionId };
  }
  if (gate.action === 'delegate' && platformId === gate.targetAgentGroupId) {
    return { allowed: true, decisionId: gate.decisionId };
  }
  return {
    allowed: false,
    decisionId: gate.decisionId,
    reason: gate.action === 'delegate' ? 'wrong_agent_destination' : 'agent_destination_forbidden',
  };
}

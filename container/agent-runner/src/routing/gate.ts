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
    // 已路由的执行只能发送到触发它的精确会话。若该路由缺失（例如 Gate
    // 格式损坏或恢复不完整），必须 fail-closed，不能把任意频道当作来源会话。
    if (!gate.originChannelType || !gate.originPlatformId) {
      return {
        allowed: false,
        decisionId: gate.decisionId,
        reason: 'origin_destination_unavailable',
      };
    }
    if (
      channelType !== gate.originChannelType ||
      platformId !== gate.originPlatformId ||
      (gate.originThreadId !== undefined && (threadId ?? null) !== gate.originThreadId)
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

/**
 * 保护 Host 侧收件人刻意对容器保持不透明的出站操作（例如 Roster 私信或
 * Roster 邀请）。
 *
 * Routing 决策只会授权一个明确的来源会话或一个明确的 Worker。无法从不透明
 * 行中证明它服从该决策，因此在已路由的执行中不得写出此类行。它与普通的
 * system/audit 行刻意区分：后者是本地控制面记录，不是发送给其他收件人的请求。
 */
export function enforceRoutingOpaqueOutbound():
  | { allowed: true; decisionId?: string }
  | { allowed: false; decisionId: string; reason: string } {
  const gate = getRoutingGate();
  if (!gate) return { allowed: true };
  return {
    allowed: false,
    decisionId: gate.decisionId,
    reason: 'opaque_destination_forbidden',
  };
}

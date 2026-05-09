/**
 * ERP audit delivery-action handler.
 *
 * The container writes one `kind='system'` outbound message per ERP gateway
 * call with `action='erp_audit'` and the call metadata. The host side of
 * the delivery loop dispatches it here; we persist it in the central DB
 * and the message is considered delivered (no user-facing output).
 *
 * Intentionally best-effort: if the audit row write fails we log and move
 * on. Never block or retry the container's message flow on audit failures.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { recordErpAudit, type ErpAuditEntry } from '../../db/erp-audit.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

function readString(content: Record<string, unknown>, key: string): string | undefined {
  const value = content[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(content: Record<string, unknown>, key: string): number | undefined {
  const value = content[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toStatus(raw: unknown): 'ok' | 'error' {
  return raw === 'ok' ? 'ok' : 'error';
}

async function handleErpAudit(content: Record<string, unknown>, session: Session): Promise<void> {
  const path = readString(content, 'path');
  const requesterSource = readString(content, 'requesterSource');
  if (!path || !requesterSource) {
    log.warn('erp_audit ignored: missing required fields', {
      sessionId: session.id,
      hasPath: !!path,
      hasRequesterSource: !!requesterSource,
    });
    return;
  }

  const entry: ErpAuditEntry = {
    sessionId: session.id,
    agentGroupId: session.agent_group_id,
    userId: readString(content, 'userId') ?? null,
    path,
    operation: readString(content, 'operation') ?? null,
    requesterSource,
    status: toStatus(content.status),
    httpStatus: readNumber(content, 'httpStatus') ?? null,
    durationMs: readNumber(content, 'durationMs') ?? null,
    idempotencyKey: readString(content, 'idempotencyKey') ?? null,
    inputHash: readString(content, 'inputHash') ?? null,
    errorMsg: readString(content, 'errorMsg') ?? null,
  };

  try {
    recordErpAudit(entry);
  } catch (err) {
    log.error('erp_audit row write failed', { sessionId: session.id, err });
  }
}

registerDeliveryAction('erp_audit', handleErpAudit);

import { describe, expect, it } from 'vitest';

import { policyCheckFailedTotal } from './metrics.js';

// The fail-closed metric (roadmap 5.8) is load-bearing for observability: its
// name and {policy,reason} labels are referenced verbatim by the
// AgentDeskApprovalIdentityRejections alert (infra/observability/prometheus/
// alerts.yml) and RUNBOOK §3.11. A rename or label change here silently breaks
// that alert, so pin the contract.
describe('policyCheckFailedTotal (roadmap 5.8 fail-closed metric)', () => {
  it('is named <ns>_policy_check_failed_total', async () => {
    const m = await policyCheckFailedTotal.get();
    expect(m.name).toMatch(/_policy_check_failed_total$/);
    expect(m.type).toBe('counter');
  });

  it('counts by policy + reason labels', async () => {
    policyCheckFailedTotal.inc({ policy: 'approval_operator_identity', reason: 'mismatch' });
    policyCheckFailedTotal.inc({ policy: 'approval_operator_identity', reason: 'mismatch' });
    policyCheckFailedTotal.inc({ policy: 'command_gate', reason: 'admin_denied' });

    const samples = (await policyCheckFailedTotal.get()).values;
    const find = (policy: string, reason: string) =>
      samples.find((s) => s.labels.policy === policy && s.labels.reason === reason)?.value;

    expect(find('approval_operator_identity', 'mismatch')).toBe(2);
    expect(find('command_gate', 'admin_denied')).toBe(1);
  });
});

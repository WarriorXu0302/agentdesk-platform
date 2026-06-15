import { describe, expect, it } from 'vitest';

import { policyCheckFailedTotal, recordingActorRejectedTotal, rosterDmRejectedTotal } from './metrics.js';

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

// Identity-forgery detection metrics: the AgentDeskRecordingActorForged (ADR-0046)
// and AgentDeskRosterOptInCardForged (ADR-0045) alerts reference these names +
// labels verbatim in alerts.yml. A rename / label change here silently breaks the
// alert, so pin the contract (same discipline as policyCheckFailedTotal).
describe('recordingActorRejectedTotal (ADR-0046 audit-attribution forgery)', () => {
  it('is named <ns>_recording_actor_rejected_total and counts by action', async () => {
    recordingActorRejectedTotal.inc({ action: 'gateway_audit' });
    const m = await recordingActorRejectedTotal.get();
    expect(m.name).toMatch(/_recording_actor_rejected_total$/);
    expect(m.type).toBe('counter');
    expect(m.values.some((s) => s.labels.action === 'gateway_audit')).toBe(true);
  });
});

describe('rosterDmRejectedTotal (ADR-0045 forged opt-in card alert depends on reason label)', () => {
  it('is named <ns>_roster_dm_rejected_total and the forged_optin_card reason label is recordable', async () => {
    rosterDmRejectedTotal.inc({ reason: 'forged_optin_card' });
    const m = await rosterDmRejectedTotal.get();
    expect(m.name).toMatch(/_roster_dm_rejected_total$/);
    expect(m.type).toBe('counter');
    // The alert keys on reason="forged_optin_card"; make sure that exact label fires.
    expect(m.values.some((s) => s.labels.reason === 'forged_optin_card')).toBe(true);
  });
});

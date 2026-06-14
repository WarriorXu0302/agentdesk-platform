/**
 * Roster-DM directed opt-in card builder (ADR-0044 Stage 3).
 *
 * The security property under test: the card embeds the HOST-stamped roster.optin
 * payload VERBATIM as its button action value, and the SAME parser the live
 * feishu card-action handler uses (parseRosterOptIn) recovers exactly those
 * fields. captureDirectedCardConsent trusts expectedUserId/scopeId from this
 * value without re-deriving them, so the card must carry the host's fields and
 * nothing the container could have substituted (load-bearing invariant, see
 * src/roster-invite.ts).
 */
import { describe, it, expect } from 'vitest';

import { buildFeishuRosterOptInCard } from './primitives.js';
import { parseRosterOptIn } from './roster-consent.js';

interface CardButton {
  tag: string;
  value: Record<string, unknown>;
}
interface CardCard {
  schema: string;
  header: { title: { content: string } };
  body: { elements: Array<{ tag: string; actions?: CardButton[] }> };
}

function optInButtonValue(card: CardCard): unknown {
  const action = card.body.elements.find((e) => e.tag === 'action');
  return action?.actions?.[0]?.value;
}

describe('buildFeishuRosterOptInCard', () => {
  const optIn = {
    kind: 'roster.optin' as const,
    scopeId: 'sess-root-1',
    slotLabel: 'approver',
    agentGroupId: 'ag-1',
    expectedUserId: 'ou_invitee',
    expiresAt: '2026-06-15T00:00:00.000Z',
  };

  it('embeds the host-stamped opt-in payload as the button value, verbatim', () => {
    const card = buildFeishuRosterOptInCard({ slotLabel: 'approver', optIn }) as unknown as CardCard;
    expect(card.schema).toBe('2.0');
    expect(optInButtonValue(card)).toEqual(optIn);
  });

  it('the embedded value round-trips through parseRosterOptIn (what consent capture runs)', () => {
    const card = buildFeishuRosterOptInCard({ slotLabel: 'approver', optIn }) as unknown as CardCard;
    const parsed = parseRosterOptIn(optInButtonValue(card));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      kind: 'roster.optin',
      scopeId: 'sess-root-1',
      slotLabel: 'approver',
      agentGroupId: 'ag-1',
      expectedUserId: 'ou_invitee',
      expiresAt: '2026-06-15T00:00:00.000Z',
    });
  });

  it('uses a default invite body that names the slot, or an explicit prompt when given', () => {
    const dflt = JSON.stringify(buildFeishuRosterOptInCard({ slotLabel: 'ops-lead', optIn }));
    expect(dflt).toContain('ops-lead');
    const custom = JSON.stringify(
      buildFeishuRosterOptInCard({ slotLabel: 'ops-lead', optIn, prompt: 'Join as reviewer?' }),
    );
    expect(custom).toContain('Join as reviewer?');
  });
});

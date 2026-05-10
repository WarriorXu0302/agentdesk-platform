import { describe, expect, it } from 'bun:test';

import { shouldEndForIdentityChange } from './poll-loop.js';

describe('shouldEndForIdentityChange', () => {
  it('does not end when there is no current identity', () => {
    expect(
      shouldEndForIdentityChange(null, { userId: 'feishu:ou_alice', source: 'session' }),
    ).toBe(false);
  });

  it('does not end when current identity is agent-asserted', () => {
    // If the current turn was agent-asserted to begin with, the new
    // message's arrival doesn't make the situation worse — tool calls
    // are already getting the stricter backend treatment.
    expect(
      shouldEndForIdentityChange(
        { userId: 'feishu:ou_alice', source: 'agent-asserted' },
        { userId: 'feishu:ou_bob', source: 'session' },
      ),
    ).toBe(false);
  });

  it('does not end when incoming identity is agent-asserted', () => {
    // Scheduled tasks and similar agent-asserted follow-ups shouldn't
    // force a new turn — they're not a different trusted user.
    expect(
      shouldEndForIdentityChange(
        { userId: 'feishu:ou_alice', source: 'session' },
        { userId: null, source: 'agent-asserted' },
      ),
    ).toBe(false);
  });

  it('does not end when both sides are the same session-trusted user', () => {
    // Alice sends two messages in quick succession — keep the warm
    // query, don't restart the turn.
    expect(
      shouldEndForIdentityChange(
        { userId: 'feishu:ou_alice', source: 'session' },
        { userId: 'feishu:ou_alice', source: 'session' },
      ),
    ).toBe(false);
  });

  it('ends when a DIFFERENT session-trusted user message arrives mid-turn', () => {
    // The core case this guard exists for: Alice's turn still running,
    // Bob's message just landed in the shared session. Letting it into
    // the active query would attribute Bob's subsequent tool calls to
    // Alice.
    expect(
      shouldEndForIdentityChange(
        { userId: 'feishu:ou_alice', source: 'session' },
        { userId: 'feishu:ou_bob', source: 'session' },
      ),
    ).toBe(true);
  });

  it('does not end when current identity has null userId', () => {
    // Defensive: a current identity with no userId shouldn't pin
    // subsequent messages. Treat as "no identity to protect".
    expect(
      shouldEndForIdentityChange(
        { userId: null, source: 'session' },
        { userId: 'feishu:ou_alice', source: 'session' },
      ),
    ).toBe(false);
  });
});

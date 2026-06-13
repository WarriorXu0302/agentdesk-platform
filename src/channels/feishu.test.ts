import crypto from 'crypto';

import { describe, expect, it } from 'vitest';

import {
  cardActionOperatorAllowed,
  decryptFeishuPayload,
  normalizeFeishuEventMode,
  normalizeFeishuPlatformId,
  parseFeishuQuestionActionPayload,
  signFeishuBody,
} from './feishu.js';
import { buildAskQuestionFallbackText, isExpiredQuestionPayload } from './feishu/primitives.js';

function encryptFeishuPayload(encryptKey: string, payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(16);
  const key = crypto.createHash('sha256').update(encryptKey).digest();
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted]).toString('base64');
}

describe('signFeishuBody', () => {
  it('matches the Feishu webhook sha256 signing scheme', () => {
    const signature = signFeishuBody({
      encryptKey: 'encrypt_key',
      timestamp: '1711111111',
      nonce: 'nonce-test',
      rawBody: '{"type":"url_verification","challenge":"abc"}',
    });

    expect(signature).toBe(
      crypto
        .createHash('sha256')
        .update('1711111111' + 'nonce-test' + 'encrypt_key' + '{"type":"url_verification","challenge":"abc"}')
        .digest('hex'),
    );
  });
});

describe('decryptFeishuPayload', () => {
  it('decrypts AES-256-CBC encrypted Feishu payloads', () => {
    const payload = { type: 'url_verification', challenge: 'encrypted-challenge-token' };
    const encrypted = encryptFeishuPayload('encrypt_key', payload);

    expect(decryptFeishuPayload('encrypt_key', encrypted)).toEqual(payload);
  });

  it('returns null when ciphertext is invalid', () => {
    expect(decryptFeishuPayload('encrypt_key', 'not-base64')).toBeNull();
  });
});

describe('normalizeFeishuPlatformId', () => {
  it('maps group chats to namespaced chat ids', () => {
    expect(
      normalizeFeishuPlatformId({
        chatId: 'oc_group_chat',
        chatType: 'group',
        senderOpenId: 'ou_sender',
      }),
    ).toBe('feishu:oc_group_chat');
  });

  it('maps p2p chats to sender-scoped synthetic ids', () => {
    expect(
      normalizeFeishuPlatformId({
        chatId: 'oc_dm_chat',
        chatType: 'p2p',
        senderOpenId: 'ou_sender',
      }),
    ).toBe('feishu:p2p:ou_sender');
  });

  it('fails closed for p2p chats without sender identity', () => {
    expect(
      normalizeFeishuPlatformId({
        chatId: 'oc_dm_chat',
        chatType: 'p2p',
      }),
    ).toBeNull();
  });
});

describe('normalizeFeishuEventMode', () => {
  it('defaults to webhook for empty or invalid values', () => {
    expect(normalizeFeishuEventMode(undefined)).toBe('webhook');
    expect(normalizeFeishuEventMode('')).toBe('webhook');
    expect(normalizeFeishuEventMode('unexpected')).toBe('webhook');
  });

  it('accepts long-connection aliases', () => {
    expect(normalizeFeishuEventMode('long-connection')).toBe('long-connection');
    expect(normalizeFeishuEventMode('long_connection')).toBe('long-connection');
    expect(normalizeFeishuEventMode('ws')).toBe('long-connection');
  });

  it('accepts hybrid aliases', () => {
    expect(normalizeFeishuEventMode('hybrid')).toBe('hybrid');
    expect(normalizeFeishuEventMode('both')).toBe('hybrid');
  });
});

describe('parseFeishuQuestionActionPayload', () => {
  it('accepts valid ask-question callback payloads', () => {
    expect(
      parseFeishuQuestionActionPayload({
        kind: 'card.ask_question',
        questionId: 'q-1',
        selectedOption: 'approve',
        selectedLabel: 'Approved',
        expectedUserId: 'ou_user',
        expiresAt: Date.now() + 60_000,
      }),
    ).toEqual({
      kind: 'card.ask_question',
      questionId: 'q-1',
      selectedOption: 'approve',
      selectedLabel: 'Approved',
      expectedUserId: 'ou_user',
      expiresAt: expect.any(Number),
    });
  });

  it('rejects expired payloads', () => {
    expect(
      parseFeishuQuestionActionPayload({
        kind: 'card.ask_question',
        questionId: 'q-1',
        selectedOption: 'approve',
        expiresAt: Date.now() - 1,
      }),
    ).toBeNull();
  });

  it('rejects unrelated action payloads', () => {
    expect(
      parseFeishuQuestionActionPayload({
        kind: 'other',
        questionId: 'q-1',
        selectedOption: 'approve',
      }),
    ).toBeNull();
  });
});

describe('cardActionOperatorAllowed (fail-closed wrong-user gate, ADR-0019)', () => {
  it('allows the exact expected user', () => {
    expect(cardActionOperatorAllowed('ou_user', 'ou_user')).toBe(true);
  });

  it('rejects a different operator on a user-scoped card', () => {
    expect(cardActionOperatorAllowed('ou_user', 'ou_other')).toBe(false);
  });

  it('rejects when the operator identity is missing on a user-scoped card', () => {
    // The old short-circuit let an empty operatorUserId skip the check; this
    // is now treated as "identity unconfirmed" and denied.
    expect(cardActionOperatorAllowed('ou_user', '')).toBe(false);
  });

  it('allows unscoped cards regardless of operator', () => {
    expect(cardActionOperatorAllowed(undefined, '')).toBe(true);
    expect(cardActionOperatorAllowed(undefined, 'ou_anyone')).toBe(true);
  });
});

describe('buildAskQuestionFallbackText (roadmap 6.4)', () => {
  const opts = [
    { label: 'Approve', value: 'approve', selectedLabel: 'Approve' },
    { label: 'Reject', value: 'reject', selectedLabel: 'Reject' },
  ];

  it('renders the question, numbered options, and a reply hint', () => {
    const text = buildAskQuestionFallbackText({ title: 'Decision', question: 'Approve invoice INV-1?', options: opts });
    expect(text).toContain('Approve invoice INV-1?');
    expect(text).toContain('1. Approve');
    expect(text).toContain('2. Reject');
    expect(text).toContain('Reply with the option number');
  });

  it('falls back to the title when the question is empty', () => {
    const text = buildAskQuestionFallbackText({ title: 'Decision', question: '   ', options: opts });
    expect(text.startsWith('Decision')).toBe(true);
  });
});

describe('isExpiredQuestionPayload (roadmap 6.2)', () => {
  const base = { kind: 'card.ask_question', questionId: 'q1', selectedOption: 'approve' };

  it('is true for a well-formed payload whose expiresAt is in the past', () => {
    expect(isExpiredQuestionPayload({ ...base, expiresAt: 1000 }, 5000)).toBe(true);
  });

  it('is false for a payload that has not expired yet', () => {
    expect(isExpiredQuestionPayload({ ...base, expiresAt: 9000 }, 5000)).toBe(false);
  });

  it('is false for a payload with no expiry (cannot be "expired")', () => {
    expect(isExpiredQuestionPayload(base, 5000)).toBe(false);
  });

  it('is false for genuinely unsupported payloads (wrong kind / not a record / missing fields)', () => {
    expect(isExpiredQuestionPayload({ kind: 'other', expiresAt: 1 }, 5000)).toBe(false);
    expect(isExpiredQuestionPayload(null, 5000)).toBe(false);
    expect(isExpiredQuestionPayload({ kind: 'card.ask_question', expiresAt: 1 }, 5000)).toBe(false);
  });
});

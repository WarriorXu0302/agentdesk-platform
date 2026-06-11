import crypto from 'crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptFeishuPayload,
  normalizeFeishuEventMode,
  normalizeFeishuPlatformId,
  parseFeishuQuestionActionPayload,
  signFeishuBody,
} from './feishu.js';

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

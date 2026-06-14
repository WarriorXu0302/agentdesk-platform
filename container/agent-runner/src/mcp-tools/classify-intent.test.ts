import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { setRequestIdentity, clearRequestIdentity } from '../request-context.js';
import { classifyIntent, confidenceAdvisory, escalateToHuman } from './classify-intent.js';

function seedWorkers(names: string[]): void {
  const stmt = getInboundDb().prepare(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
     VALUES (?, ?, 'agent', NULL, NULL, ?)`,
  );
  for (const n of names) stmt.run(n, n, `ag-${n}`);
}

beforeEach(() => {
  initTestSessionDb();
  seedWorkers(['finance-worker', 'sales-worker']);
});

afterEach(() => {
  clearRequestIdentity();
  closeSessionDb();
});

describe('classifyIntent tool handler', () => {
  it('returns a classificationId in the tool result text', async () => {
    const result = await classifyIntent.handler({
      userMessage: 'please approve INV-001',
      recommendedWorker: 'finance-worker',
      confidence: 0.9,
      candidates: ['finance-worker'],
      reasoning: 'mentions approve + invoice',
      action: 'delegate',
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('classificationId:');
    const match = text.match(/classificationId: (cls-[a-z0-9-]+)/);
    expect(match).not.toBeNull();
  });

  it('writes a system outbound row with identity fields and de-duplicated candidates', async () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });

    await classifyIntent.handler({
      userMessage: 'give me a summary',
      // LLM duplicates recommendedWorker inside candidates — we must dedupe.
      recommendedWorker: 'sales-worker',
      candidates: ['sales-worker', 'finance-worker', 'sales-worker'],
      confidence: 0.8,
      action: 'delegate',
    });

    const row = getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1")
      .get() as { content: string };
    const payload = JSON.parse(row.content);
    expect(payload.action).toBe('classify_intent');
    expect(payload.userId).toBe('feishu:ou_alice');
    expect(payload.channelType).toBe('feishu');
    expect(payload.platformId).toBe('feishu:p2p:ou_alice');
    expect(payload.threadId).toBeNull();
    expect(payload.candidates).toEqual(['sales-worker', 'finance-worker']);
    expect(payload.classificationId).toMatch(/^cls-/);
  });

  it('rejects out-of-range confidence', async () => {
    const below = await classifyIntent.handler({
      userMessage: 'x',
      confidence: -0.1,
      action: 'delegate',
    });
    expect(below.isError).toBe(true);
    expect(below.content[0]?.text).toMatch(/\[0, 1\]/);

    const above = await classifyIntent.handler({
      userMessage: 'x',
      confidence: 1.5,
      action: 'delegate',
    });
    expect(above.isError).toBe(true);
  });

  it('rejects a recommendedWorker that is not a real destination', async () => {
    const result = await classifyIntent.handler({
      userMessage: 'x',
      recommendedWorker: 'nonexistent-worker',
      confidence: 0.9,
      action: 'delegate',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a known agent destination/);
  });

  it('allows classification without a recommendedWorker (e.g. clarify / answer_self)', async () => {
    const result = await classifyIntent.handler({
      userMessage: 'vague question',
      confidence: 0.3,
      action: 'clarify',
    });
    expect(result.isError).toBeUndefined();
  });

  it('treats a single-candidate count correctly after dedup', async () => {
    setRequestIdentity({
      userId: 'feishu:ou_bob',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_bob',
      threadId: null,
      source: 'session',
    });

    const result = await classifyIntent.handler({
      userMessage: 'hi',
      recommendedWorker: 'finance-worker',
      // Only candidate is identical to recommendedWorker — after dedup,
      // count should be 1, NOT 2 (the old bug).
      candidates: ['finance-worker'],
      confidence: 0.65,
      action: 'delegate',
    });
    const text = result.content[0]?.text ?? '';
    // A correctly de-duped single-candidate, low-confidence classification
    // should be advised to clarify on confidence alone — not trip the
    // "multiple plausible workers" branch.
    expect(text.toLowerCase()).toContain('ask_user_question');
  });
});

describe('confidenceAdvisory', () => {
  it('treats out-of-range confidence as invalid', () => {
    expect(confidenceAdvisory(Number.NaN, 2)).toMatch(/invalid/i);
    expect(confidenceAdvisory(-0.1, 2)).toMatch(/invalid/i);
    expect(confidenceAdvisory(1.1, 2)).toMatch(/invalid/i);
  });

  it('refuses to delegate when no candidates are identified', () => {
    expect(confidenceAdvisory(0.95, 0)).toMatch(/no candidate/i);
  });

  it('asks for clarification below 0.70 confidence', () => {
    expect(confidenceAdvisory(0.5, 1)).toMatch(/ask_user_question/);
    expect(confidenceAdvisory(0.69, 1)).toMatch(/ask_user_question/);
  });

  it('asks for clarification when multiple plausible workers at moderate confidence', () => {
    expect(confidenceAdvisory(0.65, 3)).toMatch(/ask_user_question/);
  });

  it('asks for a user-side confirmation at moderate-high confidence', () => {
    const advisory = confidenceAdvisory(0.8, 1);
    expect(advisory.toLowerCase()).toContain('delegate');
    expect(advisory.toLowerCase()).toContain('confirmation');
  });

  it('allows direct delegation at ≥ 0.85', () => {
    const advisory = confidenceAdvisory(0.9, 1);
    expect(advisory.toLowerCase()).toContain('delegate directly');
  });

  it('boundary: exactly 0.70 still triggers the "moderate" branch, not clarify', () => {
    const advisory = confidenceAdvisory(0.7, 1);
    // 0.70 is NOT < 0.70, so it falls into the moderate bucket.
    expect(advisory.toLowerCase()).toContain('moderate');
  });

  it('boundary: exactly 0.85 falls into the "high" bucket', () => {
    expect(confidenceAdvisory(0.85, 1).toLowerCase()).toContain('delegate directly');
  });

  it('honors a per-group clarify threshold (roadmap 2.4)', () => {
    // Stricter group: clarify below 0.80. 0.75 now clarifies (would not at 0.70).
    expect(confidenceAdvisory(0.75, 1, 0.8)).toMatch(/ask_user_question/);
    expect(confidenceAdvisory(0.75, 1, 0.8)).toContain('0.80');
    // Looser group: clarify below 0.50. 0.6 now delegates (moderate) instead of clarifying.
    expect(confidenceAdvisory(0.6, 1, 0.5).toLowerCase()).toContain('moderate');
    // Default (no arg) keeps the 0.70 behavior.
    expect(confidenceAdvisory(0.69, 1)).toMatch(/ask_user_question/);
    expect(confidenceAdvisory(0.69, 1)).toContain('0.70');
  });
});

describe('escalateToHuman tool handler (ADR-0038)', () => {
  it('emits an orthogonal escalate system action with reason + urgency + identity', async () => {
    setRequestIdentity({
      userId: 'feishu:ou_alice',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_alice',
      threadId: null,
      source: 'session',
    });

    const result = await escalateToHuman.handler({ reason: 'customer demands a manager', urgency: 'high' });
    expect(result.isError).toBeUndefined();

    const row = getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'system' ORDER BY seq DESC LIMIT 1")
      .get() as { content: string };
    const payload = JSON.parse(row.content);
    expect(payload.action).toBe('escalate'); // NOT 'classify_intent' — orthogonal
    expect(payload.escalation_reason).toBe('customer demands a manager');
    expect(payload.urgency_level).toBe('high');
    expect(payload.userId).toBe('feishu:ou_alice');
  });

  it('requires a non-empty reason', async () => {
    const result = await escalateToHuman.handler({ urgency: 'low' });
    expect(result.isError).toBe(true);
  });
});

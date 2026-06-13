import { describe, expect, it } from 'vitest';

import { normalizeOption, normalizeOptions } from './ask-question.js';

describe('normalizeOption', () => {
  it('maps a bare string to label = selectedLabel = value', () => {
    expect(normalizeOption('Approve')).toEqual({
      label: 'Approve',
      selectedLabel: 'Approve',
      value: 'Approve',
    });
  });

  it('defaults selectedLabel and value to label when only label is given', () => {
    expect(normalizeOption({ label: 'Reject' })).toEqual({
      label: 'Reject',
      selectedLabel: 'Reject',
      value: 'Reject',
    });
  });

  // This is the mechanism the "structured rejection reason" pattern relies on
  // (docs/agent-runner-details.md, roadmap 6.8): a distinct `value` is what the
  // host writes back as selectedOption, so the agent gets the reason in one
  // round-trip. A regression here would silently break that pattern.
  it('preserves a `value` distinct from its display `label`', () => {
    expect(normalizeOption({ label: 'Reject — amount exceeds policy', value: 'reject:over-policy' })).toEqual({
      label: 'Reject — amount exceeds policy',
      selectedLabel: 'Reject — amount exceeds policy',
      value: 'reject:over-policy',
    });
  });

  it('keeps selectedLabel independent of value', () => {
    expect(normalizeOption({ label: 'Approve', selectedLabel: 'Approved ✓', value: 'approve' })).toEqual({
      label: 'Approve',
      selectedLabel: 'Approved ✓',
      value: 'approve',
    });
  });

  it('normalizes a mixed array of strings and objects', () => {
    const opts = normalizeOptions(['approve', { label: 'Reject', value: 'reject:needs-manager' }]);
    expect(opts.map((o) => o.value)).toEqual(['approve', 'reject:needs-manager']);
  });
});

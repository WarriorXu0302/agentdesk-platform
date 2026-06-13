import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

import { findNoopRoutedReceivers } from './check-alertmanager.js';

describe('findNoopRoutedReceivers (alertmanager pre-prod gate)', () => {
  it('flags the shipped placeholder (all routes → null no-op receiver)', () => {
    const yaml = `
route:
  receiver: 'null'
  routes:
    - matchers: [severity = critical]
      receiver: 'null'
receivers:
  - name: 'null'
`;
    expect(findNoopRoutedReceivers(yaml)).toEqual(['null']);
  });

  it('passes when the critical route points at a receiver with a real config', () => {
    const yaml = `
route:
  receiver: 'slack'
  routes:
    - matchers: [severity = critical]
      receiver: 'pagerduty'
receivers:
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/x'
  - name: 'pagerduty'
    pagerduty_configs:
      - routing_key: 'abc'
`;
    expect(findNoopRoutedReceivers(yaml)).toEqual([]);
  });

  it('still flags a partial wiring (warnings real, critical still null)', () => {
    const yaml = `
route:
  receiver: 'slack'
  routes:
    - matchers: [severity = critical]
      receiver: 'null'
receivers:
  - name: 'slack'
    slack_configs:
      - api_url: 'https://hooks.slack.com/services/x'
  - name: 'null'
`;
    expect(findNoopRoutedReceivers(yaml)).toEqual(['null']);
  });

  it('ignores commented-out example receivers/configs', () => {
    const yaml = `
route:
  receiver: 'null'
receivers:
  - name: 'null'
  # - name: 'slack'
  #   slack_configs:
  #     - api_url: 'https://hooks.slack.com/services/x'
`;
    // The only ACTIVE receiver ('null') has no config and is routed to → flagged.
    expect(findNoopRoutedReceivers(yaml)).toEqual(['null']);
  });

  it('the real shipped default config fails the gate (it is intentionally a placeholder)', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const real = fs.readFileSync(
      path.resolve(here, '..', 'infra', 'observability', 'alertmanager', 'alertmanager.yml'),
      'utf8',
    );
    // Pin the contract: the repo default IS placeholder routing, so the gate
    // must flag it. (If someone wires a real receiver into the repo default,
    // update this expectation deliberately.)
    expect(findNoopRoutedReceivers(real).length).toBeGreaterThan(0);
  });
});

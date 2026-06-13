/**
 * Self-test for the echo channel extension.
 *
 * Demonstrates the recommended workflow for a fork-free channel author: import
 * the reusable `assertChannelAdapterContract` asset from the platform and run
 * your adapter through it in your own test suite. A passing assertion is the
 * SAME structural admission gate the host applies at load time (ADR-0030 /
 * ADR-0031) — so if this passes locally, the host won't reject your adapter on
 * structural grounds.
 *
 * Run it however you like (vitest, node:test, a bare script). Here it's a tiny
 * standalone script so it has zero test-runner dependency:
 *
 *   pnpm exec tsx examples/echo-channel/index.selftest.ts
 *
 * (When developing out-of-tree, swap the relative specifiers for your install's
 * platform path — see index.ts and README.md.)
 */
import { assertChannelAdapterContract } from '../../src/channels/channel-contract.js';
import { createEchoAdapter } from './index.js';

const adapter = createEchoAdapter();

// Throws on any structural violation; returns the (narrowed) adapter on success.
assertChannelAdapterContract(adapter);

// A couple of extra sanity checks an author might add on top of the gate.
if (adapter.channelType !== 'echo') throw new Error('channelType drifted from manifest');
if (typeof adapter.deliver !== 'function') throw new Error('deliver missing');

// eslint-disable-next-line no-console
console.log('echo-channel: assertChannelAdapterContract passed ✓');

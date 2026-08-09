import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from '../db/connection.js';
import {
  clearRoutingGate,
  enforceRoutingDestination,
  enforceRoutingOpaqueOutbound,
  getRoutingGate,
  setRoutingGate,
} from './gate.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('cross-process routing gate', () => {
  it('blocks agent destinations for answer_self while allowing the origin channel', () => {
    setRoutingGate({
      decisionId: 'route-1',
      anchorId: 'm1',
      action: 'answer_self',
      originChannelType: 'cli',
      originPlatformId: 'local',
      originThreadId: 'thread-1',
    });
    expect(enforceRoutingDestination('agent', 'ag-finance')).toEqual({
      allowed: false,
      decisionId: 'route-1',
      reason: 'agent_destination_forbidden',
    });
    expect(enforceRoutingDestination('cli', 'local', 'thread-1')).toEqual({
      allowed: true,
      decisionId: 'route-1',
    });
    expect(enforceRoutingDestination('cli', 'local', 'thread-2')).toEqual({
      allowed: false,
      decisionId: 'route-1',
      reason: 'non_origin_destination',
    });
    expect(enforceRoutingDestination('feishu', 'another-channel')).toEqual({
      allowed: false,
      decisionId: 'route-1',
      reason: 'non_origin_destination',
    });
  });

  it('allows only the selected worker for a delegate gate', () => {
    setRoutingGate({
      decisionId: 'route-2',
      anchorId: 'm2',
      action: 'delegate',
      targetAgentGroupId: 'ag-finance',
    });
    expect(enforceRoutingDestination('agent', 'ag-finance').allowed).toBe(true);
    expect(enforceRoutingDestination('agent', 'ag-hr').allowed).toBe(false);
  });

  it('is legacy-compatible when no gate exists and clears atomically', () => {
    expect(enforceRoutingDestination('agent', 'ag-any')).toEqual({ allowed: true });
    setRoutingGate({ decisionId: 'route-3', anchorId: 'm3', action: 'reject' });
    expect(getRoutingGate()?.decisionId).toBe('route-3');
    clearRoutingGate();
    expect(getRoutingGate()).toBeUndefined();
    expect(enforceRoutingDestination('agent', 'ag-any')).toEqual({ allowed: true });
  });

  it('fails closed for a channel destination when a persisted gate has no origin route', () => {
    setRoutingGate({ decisionId: 'route-4', anchorId: 'm4', action: 'answer_self' });
    expect(enforceRoutingDestination('cli', 'local')).toEqual({
      allowed: false,
      decisionId: 'route-4',
      reason: 'origin_destination_unavailable',
    });
  });

  it('rejects opaque recipient operations whenever a routed execution gate is active', () => {
    expect(enforceRoutingOpaqueOutbound()).toEqual({ allowed: true });
    setRoutingGate({ decisionId: 'route-5', anchorId: 'm5', action: 'delegate', targetAgentGroupId: 'ag-finance' });
    expect(enforceRoutingOpaqueOutbound()).toEqual({
      allowed: false,
      decisionId: 'route-5',
      reason: 'opaque_destination_forbidden',
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  admissionQueueSize,
  clearAdmissionQueue,
  drainAdmissionSlot,
  enqueueAdmission,
  type AdmissionDeps,
} from './admission-queue.js';
import type { Session } from './types.js';

function sess(id: string, status: Session['status'] = 'active'): Session {
  return { id, agent_group_id: 'ag-1', status } as Session;
}

function makeDeps(overrides: Partial<AdmissionDeps> = {}): AdmissionDeps & { woken: string[] } {
  const woken: string[] = [];
  return {
    woken,
    getSession: (id) => sess(id),
    hasDueWork: () => true,
    wake: (s) => {
      woken.push(s.id);
      return Promise.resolve(true);
    },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  clearAdmissionQueue();
});

describe('admission queue (concurrency stage 0)', () => {
  it('dedupes: the same session enqueues at most once until popped', () => {
    enqueueAdmission('s1');
    enqueueAdmission('s1');
    enqueueAdmission('s2');
    expect(admissionQueueSize()).toBe(2);
  });

  it('admits FIFO — one admission per freed slot', async () => {
    enqueueAdmission('s1');
    enqueueAdmission('s2');
    const deps = makeDeps();

    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['s1']); // exactly one per slot
    expect(admissionQueueSize()).toBe(1);

    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['s1', 's2']);
    expect(admissionQueueSize()).toBe(0);
  });

  it('skips stale entries (gone / archived / no due work) and admits the next candidate', async () => {
    enqueueAdmission('gone');
    enqueueAdmission('archived');
    enqueueAdmission('idle');
    enqueueAdmission('real');
    const deps = makeDeps({
      getSession: (id) => (id === 'gone' ? undefined : sess(id, id === 'archived' ? 'archived' : 'active')),
      hasDueWork: (s) => s.id !== 'idle',
    });

    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['real']); // three stale entries skipped in one pass
    expect(admissionQueueSize()).toBe(0);
  });

  it('a re-rejected wake keeps its turn: requeued at the FRONT', async () => {
    enqueueAdmission('s1');
    enqueueAdmission('s2');
    const deps = makeDeps({
      wake: vi
        .fn<AdmissionDeps['wake']>()
        .mockResolvedValueOnce(false) // s1 loses the slot race
        .mockResolvedValue(true),
    });

    drainAdmissionSlot(deps);
    await settle();
    expect(admissionQueueSize()).toBe(2); // s1 back at the front

    const deps2 = makeDeps();
    drainAdmissionSlot(deps2);
    await settle();
    expect(deps2.woken).toEqual(['s1']); // still first in line
  });

  it('empty queue is a no-op', () => {
    const deps = makeDeps();
    expect(() => drainAdmissionSlot(deps)).not.toThrow();
    expect(deps.woken).toEqual([]);
  });

  it('a lookup failure drops the entry instead of crashing the exit handler', async () => {
    enqueueAdmission('boom');
    const deps = makeDeps({
      getSession: () => {
        throw new Error('db closing');
      },
    });
    expect(() => drainAdmissionSlot(deps)).not.toThrow();
    await settle();
    expect(deps.woken).toEqual([]);
    expect(admissionQueueSize()).toBe(0); // dropped — the sweep is the fallback
  });
});

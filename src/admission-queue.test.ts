import { afterEach, describe, expect, it } from 'vitest';

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
    isRunning: () => false,
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

describe('admission queue (ADR-0059)', () => {
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

  it('skips stale entries (gone / archived / already running / no due work) and admits the next candidate', async () => {
    enqueueAdmission('gone');
    enqueueAdmission('archived');
    enqueueAdmission('running');
    enqueueAdmission('idle');
    enqueueAdmission('real');
    const deps = makeDeps({
      getSession: (id) => (id === 'gone' ? undefined : sess(id, id === 'archived' ? 'archived' : 'active')),
      isRunning: (s) => s.id === 'running',
      hasDueWork: (s) => s.id !== 'idle',
    });

    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['real']); // four stale entries skipped in one pass
    expect(admissionQueueSize()).toBe(0);
  });

  it('failure budget: first failure keeps the turn (FRONT), repeats rotate to the BACK, then eviction', async () => {
    // Red-team: a persistently-failing head must not burn every freed slot's
    // single admission attempt forever, starving everyone behind it.
    enqueueAdmission('broken');
    enqueueAdmission('healthy');
    const deps = makeDeps({
      wake: (s) => {
        deps.woken.push(s.id);
        return Promise.resolve(s.id !== 'broken');
      },
    });

    // Failure 1: keeps its turn at the front.
    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['broken']);
    expect(admissionQueueSize()).toBe(2);

    // Failure 2: rotates to the BACK — healthy is admitted on this slot's...
    // no: one slot = one attempt; broken burns this slot but moves behind.
    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['broken', 'broken']);
    expect(admissionQueueSize()).toBe(2);

    // Next slot goes to healthy — the queue is no longer starved.
    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['broken', 'broken', 'healthy']);
    expect(admissionQueueSize()).toBe(1); // broken waits at the back

    // Failure 3 (max): evicted — the sweep owns it now.
    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['broken', 'broken', 'healthy', 'broken']);
    expect(admissionQueueSize()).toBe(0);
  });

  it('requeue-front is a FORCE move: beats a tail re-enqueue from the capacity-rejection path', async () => {
    // Red-team: wakeContainer's own capacity rejection re-enqueues the id at
    // the TAIL before the drain's failure handler runs; without a force-move
    // the dedupe left it there and "keeps its turn" never actually held.
    enqueueAdmission('s1');
    enqueueAdmission('s2');
    const deps = makeDeps({
      wake: (s) => {
        deps.woken.push(s.id);
        if (s.id === 's1' && deps.woken.filter((w) => w === 's1').length === 1) {
          enqueueAdmission('s1'); // simulate the capacity-rejection tail re-enqueue
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      },
    });

    drainAdmissionSlot(deps);
    await settle();
    // s1 failed once → must be back at the FRONT despite the tail re-enqueue.
    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['s1', 's1']);
  });

  it('a probe failure drops that entry and tries the NEXT candidate — the slot is not wasted', async () => {
    enqueueAdmission('boom');
    enqueueAdmission('real');
    const deps = makeDeps({
      getSession: (id) => {
        if (id === 'boom') throw new Error('torn dir');
        return sess(id);
      },
    });

    expect(() => drainAdmissionSlot(deps)).not.toThrow();
    await settle();
    expect(deps.woken).toEqual(['real']);
    expect(admissionQueueSize()).toBe(0);
  });

  it('empty queue is a no-op', () => {
    const deps = makeDeps();
    expect(() => drainAdmissionSlot(deps)).not.toThrow();
    expect(deps.woken).toEqual([]);
  });
});

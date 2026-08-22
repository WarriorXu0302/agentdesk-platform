import { afterEach, describe, expect, it } from 'vitest';

import {
  admissionQueueSize,
  clearAdmissionQueue,
  drainAdmissionSlot,
  enqueueAdmission,
  selectNextIndex,
  sessionFairnessKey,
  type AdmissionDeps,
} from './admission-queue.js';
import { admissionWaitSeconds } from './metrics.js';
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
    slotsHeldBy: () => 0,
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  clearAdmissionQueue();
  admissionWaitSeconds.reset();
});

/** Observation count and total for the wait histogram. */
async function waitStats(): Promise<{ count: number; sum: number }> {
  const v = await admissionWaitSeconds.get();
  const pick = (suffix: string) => v.values.find((x) => x.metricName?.endsWith(suffix))?.value ?? 0;
  return { count: pick('_count'), sum: pick('_sum') };
}

describe('admission queue (ADR-0059)', () => {
  it('dedupes: the same session enqueues at most once until popped', () => {
    enqueueAdmission('s1', 'user:S1');
    enqueueAdmission('s1', 'user:S1');
    enqueueAdmission('s2', 'user:S2');
    expect(admissionQueueSize()).toBe(2);
  });

  it('admits FIFO — one admission per freed slot', async () => {
    enqueueAdmission('s1', 'user:S1');
    enqueueAdmission('s2', 'user:S2');
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
    enqueueAdmission('gone', 'user:GONE');
    enqueueAdmission('archived', 'user:ARCHIVED');
    enqueueAdmission('running', 'user:RUNNING');
    enqueueAdmission('idle', 'user:IDLE');
    enqueueAdmission('real', 'user:REAL');
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
    enqueueAdmission('broken', 'user:BROKEN');
    enqueueAdmission('healthy', 'user:HEALTHY');
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
    enqueueAdmission('s1', 'user:S1');
    enqueueAdmission('s2', 'user:S2');
    const deps = makeDeps({
      wake: (s) => {
        deps.woken.push(s.id);
        if (s.id === 's1' && deps.woken.filter((w) => w === 's1').length === 1) {
          enqueueAdmission('s1', 'user:S1'); // simulate the capacity-rejection tail re-enqueue
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
    enqueueAdmission('boom', 'user:BOOM');
    enqueueAdmission('real', 'user:REAL');
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

describe('admission wait is measured honestly (capacity observability)', () => {
  it('observes exactly one wait per admitted session', async () => {
    const deps = makeDeps();
    enqueueAdmission('s-1', 'user:S-1');
    enqueueAdmission('s-2', 'user:S-2');

    drainAdmissionSlot(deps);
    await settle();
    expect((await waitStats()).count).toBe(1);

    drainAdmissionSlot(deps);
    await settle();
    expect((await waitStats()).count).toBe(2);
  });

  /**
   * The clock must run from the FIRST enqueue.
   *
   * The requeue that can actually reset it is the SECOND failure, which rotates
   * the session to the BACK via `enqueueAdmission` — the first failure uses
   * `requeueFront`, which never touches the timestamp map, so it is safe by
   * construction. An earlier version of this test drove only one failure and
   * therefore passed even with the guard removed; it is written against the
   * back-rotation path for that reason.
   */
  it('does not restart the clock when a failed admission rotates the session to the back', async () => {
    let attempt = 0;
    const deps = makeDeps({
      // fail, fail (→ back via enqueueAdmission), then succeed
      wake: () => Promise.resolve(attempt++ >= 2),
    });
    enqueueAdmission('s-slow', 'user:S-SLOW');

    // The wait accrues BEFORE the requeues. Sleeping after them instead would
    // make the assertion pass whether or not the clock was reset — the whole
    // point is that this elapsed time must SURVIVE the rotations.
    await new Promise((r) => setTimeout(r, 80));

    drainAdmissionSlot(deps); // failure 1 → requeueFront
    await settle();
    drainAdmissionSlot(deps); // failure 2 → enqueueAdmission (back)
    await settle();
    expect((await waitStats()).count).toBe(0); // failures are not waits

    drainAdmissionSlot(deps); // succeeds, immediately after the rotation
    await settle();
    const stats = await waitStats();
    expect(stats.count).toBe(1);
    // Had the back-rotation reset the clock, this would be ~0.
    expect(stats.sum).toBeGreaterThanOrEqual(0.06);
  });

  it('does not observe — or leak — a session that never took a slot', async () => {
    // Stale entry: skipped, never admitted, so it has no queue wait to report.
    const deps = makeDeps({ hasDueWork: () => false });
    enqueueAdmission('s-stale', 'user:S-STALE');
    drainAdmissionSlot(deps);
    await settle();
    expect((await waitStats()).count).toBe(0);

    // Re-enqueuing the same id afterwards must start a FRESH clock — proof the
    // skip cleared its timestamp rather than leaving it behind.
    await new Promise((r) => setTimeout(r, 60));
    enqueueAdmission('s-stale', 'user:S-STALE');
    drainAdmissionSlot(makeDeps());
    await settle();
    const stats = await waitStats();
    expect(stats.count).toBe(1);
    expect(stats.sum).toBeLessThan(0.05); // fresh clock, not the 60ms-old one
  });

  it('does not observe a session evicted after repeated failures', async () => {
    const deps = makeDeps({ wake: () => Promise.resolve(false) });
    enqueueAdmission('s-doomed', 'user:S-DOOMED');
    for (let i = 0; i < 4; i++) {
      drainAdmissionSlot(deps);
      await settle();
    }
    expect((await waitStats()).count).toBe(0);
    expect(admissionQueueSize()).toBe(0);

    // And the eviction cleared its timestamp: a later enqueue of the same id
    // starts a fresh clock instead of inheriting the abandoned one.
    await new Promise((r) => setTimeout(r, 60));
    enqueueAdmission('s-doomed', 'user:S-DOOMED');
    drainAdmissionSlot(makeDeps());
    await settle();
    const stats = await waitStats();
    expect(stats.count).toBe(1);
    expect(stats.sum).toBeLessThan(0.05);
  });
});

describe('sessionFairnessKey', () => {
  it('buckets by owner when there is one — delegation inherits it, so a fan-out charges the human', () => {
    expect(sessionFairnessKey({ id: 's1', owner_user_id: 'feishu:ou_a' } as Session)).toBe('user:feishu:ou_a');
  });

  /**
   * `expect(a).not.toBe(b)` alone cannot tell this branch from its absence —
   * the `session:<id>` fallback also gives two sessions different keys. What
   * the branch exists for is the SAME-group case: two ownerless sessions in one
   * messaging group must share a bucket, or a busy group's fan-out is never
   * charged as one and group traffic is scheduled as pure FIFO again.
   */
  it('gives two sessions in the SAME messaging group one shared bucket', () => {
    const a = sessionFairnessKey({ id: 's1', owner_user_id: null, messaging_group_id: 'mg-1' } as Session);
    const b = sessionFairnessKey({ id: 's2', owner_user_id: null, messaging_group_id: 'mg-1' } as Session);
    expect(a).toBe(b);
    expect(a).toBe('group:mg-1'); // pins the field read, not just the equality
  });

  it('keeps different messaging groups in different buckets', () => {
    const a = sessionFairnessKey({ id: 's1', owner_user_id: null, messaging_group_id: 'mg-1' } as Session);
    const b = sessionFairnessKey({ id: 's2', owner_user_id: null, messaging_group_id: 'mg-2' } as Session);
    expect(a).not.toBe(b);
  });

  it('prefers the owner over the messaging group when a session has both', () => {
    expect(sessionFairnessKey({ id: 's1', owner_user_id: 'feishu:ou_a', messaging_group_id: 'mg-1' } as Session)).toBe(
      'user:feishu:ou_a',
    );
  });

  it('falls back to the session itself, which can only advantage it', () => {
    expect(sessionFairnessKey({ id: 's1', owner_user_id: null, messaging_group_id: null } as Session)).toBe(
      'session:s1',
    );
  });
});

describe('admission fairness — least-loaded bucket first (ADR-0065)', () => {
  /** Deps whose slot counts come from a mutable map the test drives. */
  function fairDeps(held: Map<string, number>): AdmissionDeps & { woken: string[] } {
    const base = makeDeps();
    return { ...base, slotsHeldBy: (key) => held.get(key) ?? 0 };
  }

  /**
   * The case fairness exists for. One user's frontdesk delegates to three
   * workers, then someone else speaks. Under plain FIFO the newcomer waits for
   * three whole model turns; the point of this change is that they do not.
   */
  it('interleaves a newcomer ahead of a fan-out that queued first', async () => {
    const held = new Map<string, number>();
    const deps = fairDeps(held);

    enqueueAdmission('a1', 'user:A');
    enqueueAdmission('a2', 'user:A');
    enqueueAdmission('a3', 'user:A');
    enqueueAdmission('b1', 'user:B'); // arrives LAST

    // Slot 1: nobody holds anything, so FIFO decides -> a1. A now holds one.
    drainAdmissionSlot(deps);
    await settle();
    held.set('user:A', 1);

    // Slot 2: A holds 1, B holds 0 -> B jumps the two remaining A entries.
    drainAdmissionSlot(deps);
    await settle();

    expect(deps.woken).toEqual(['a1', 'b1']);
  });

  it('keeps strict FIFO inside one bucket', async () => {
    const deps = fairDeps(new Map([['user:A', 5]]));
    enqueueAdmission('a1', 'user:A');
    enqueueAdmission('a2', 'user:A');
    enqueueAdmission('a3', 'user:A');

    for (let i = 0; i < 3; i++) {
      drainAdmissionSlot(deps);
      await settle();
    }
    expect(deps.woken).toEqual(['a1', 'a2', 'a3']);
  });

  it('keeps FIFO across buckets that are equally loaded — no reordering without contention', async () => {
    const deps = fairDeps(new Map());
    enqueueAdmission('b1', 'user:B');
    enqueueAdmission('a1', 'user:A');
    enqueueAdmission('c1', 'user:C');

    for (let i = 0; i < 3; i++) {
      drainAdmissionSlot(deps);
      await settle();
    }
    expect(deps.woken).toEqual(['b1', 'a1', 'c1']);
  });

  /**
   * Least-loaded-first cannot starve: admitting a session raises its own
   * bucket's count, so the buckets equalise rather than one winning forever.
   */
  it('still drains the heavy bucket once the light one is served', async () => {
    const held = new Map<string, number>();
    const deps = fairDeps(held);
    enqueueAdmission('a1', 'user:A');
    enqueueAdmission('a2', 'user:A');
    enqueueAdmission('b1', 'user:B');

    for (const [, key] of [
      [0, 'user:A'],
      [1, 'user:B'],
      [2, 'user:A'],
    ] as const) {
      drainAdmissionSlot(deps);
      await settle();
      held.set(key, (held.get(key) ?? 0) + 1);
    }

    expect(deps.woken.sort()).toEqual(['a1', 'a2', 'b1']);
  });

  it('is unchanged from FIFO when nothing holds a slot', async () => {
    const deps = fairDeps(new Map());
    enqueueAdmission('a1', 'user:A');
    enqueueAdmission('a2', 'user:A');
    drainAdmissionSlot(deps);
    await settle();
    expect(deps.woken).toEqual(['a1']);
  });
});

describe('selectNextIndex — the ordering rule, every branch reachable', () => {
  const loads = (m: Record<string, number>) => (k: string) => m[k] ?? 0;
  const keys = (m: Record<string, string>) => (id: string) => m[id];

  it('picks the least-loaded bucket', () => {
    expect(selectNextIndex(['a1', 'a2', 'b1'], keys({ a1: 'A', a2: 'A', b1: 'B' }), loads({ A: 3, B: 0 }))).toBe(2);
  });

  it('breaks ties by queue position, so equal load is exact FIFO', () => {
    expect(selectNextIndex(['b1', 'a1', 'c1'], keys({ b1: 'B', a1: 'A', c1: 'C' }), loads({ A: 2, B: 2, C: 2 }))).toBe(
      0,
    );
  });

  it('takes the FIRST zero-load entry, not a later one', () => {
    // The `best === 0` early exit must not skip past an earlier zero.
    expect(selectNextIndex(['a1', 'b1', 'c1'], keys({ a1: 'A', b1: 'B', c1: 'C' }), loads({ A: 0, B: 0, C: 0 }))).toBe(
      0,
    );
  });

  /**
   * Unreachable through the public API now that `enqueueAdmission` requires a
   * key — which is exactly why it is tested here instead of through the queue:
   * a defensive branch nothing can execute is indistinguishable from a broken
   * one.
   */
  it('treats an entry with no recorded bucket as unloaded rather than guessing one', () => {
    expect(selectNextIndex(['a1', 'mystery'], keys({ a1: 'A' }), loads({ A: 9 }))).toBe(1);
  });

  it('returns 0 for an empty queue', () => {
    expect(selectNextIndex([], keys({}), loads({}))).toBe(0);
  });
});

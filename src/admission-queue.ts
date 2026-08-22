/**
 * Admission queue for container wakes (concurrency stage 0 — service
 * direction, ADR-0059; hardened by its pre-merge red-team round).
 *
 * Problem: when the global container cap rejects a wake, the session used to
 * wait for the next host-sweep tick — up to 60 seconds of queueing latency
 * per hop, a service-killer under load. This queue makes slot handoff
 * EVENT-DRIVEN: a capacity-rejected session enqueues here, and every freed
 * slot (container exit) admits the head immediately.
 *
 * The sweep remains the belt to this suspender: it still re-wakes any due
 * session on its tick, so a queue bug can delay a wake but never strand one.
 * Both paths funnel through wakeContainer, which is idempotent per session
 * (already-running → true; in-flight → joins the existing promise).
 *
 * FIFO with dedupe; bounded by the number of sessions by construction (a
 * session id enqueues at most once until popped).
 *
 * Failure budget (red-team: a persistently-failing head must not starve the
 * queue): the FIRST failed admission keeps the session's turn (front — the
 * common cause is losing a slot race); further failures rotate it to the
 * BACK; after MAX_ADMISSION_FAILURES consecutive failures it is EVICTED to
 * the sweep's cadence. Success clears the count.
 *
 * The drain logic takes its dependencies as a parameter so the queue's
 * behavior is unit-testable without Docker, the central DB, or session dirs.
 */
import { admissionAdmittedTotal, admissionQueueDepth, admissionWaitSeconds } from './metrics.js';
import { log } from './log.js';
import type { Session } from './types.js';

const queue: string[] = [];
const queued = new Set<string>();
const failCounts = new Map<string, number>();
/**
 * When each session FIRST entered the queue.
 *
 * Deliberately not reset by `requeueFront` / re-enqueue: a session that lost a
 * slot race and went round again waited the whole time, and restarting its
 * clock would report the prettiest numbers for exactly the sessions having the
 * worst experience. Cleared on admission, on stale skip, and on eviction — an
 * entry that never took a slot through this queue has no queue wait to report,
 * and leaving it behind would leak.
 */
const firstQueuedAt = new Map<string, number>();
/**
 * Fairness bucket per queued session, captured at first enqueue.
 *
 * Kept here rather than recomputed at drain time because the requeue paths
 * only carry a session id, and because a session's owner should not be able to
 * change its queue position mid-wait.
 */
const fairnessKeyOf = new Map<string, string>();

/** Consecutive failed admissions before a session is evicted to the sweep. */
const MAX_ADMISSION_FAILURES = 3;

/**
 * Which fairness bucket a session competes in.
 *
 * `owner_user_id` when the session has one — and delegation inherits it, so a
 * frontdesk fan-out into eight workers counts against the ONE human who asked,
 * which is the case fairness has to cover. Group chats have no owner, so they
 * bucket per messaging group: one busy group must not push another group's
 * turn back, and lumping every ownerless session together would do exactly
 * that. A session with neither gets its own bucket, which can only ever
 * advantage it — the safe direction for a fallback.
 */
export function sessionFairnessKey(session: Session): string {
  if (session.owner_user_id) return `user:${session.owner_user_id}`;
  if (session.messaging_group_id) return `group:${session.messaging_group_id}`;
  return `session:${session.id}`;
}

export function enqueueAdmission(sessionId: string, fairnessKey?: string): void {
  if (queued.has(sessionId)) return;
  if (!firstQueuedAt.has(sessionId)) firstQueuedAt.set(sessionId, Date.now());
  if (fairnessKey !== undefined && !fairnessKeyOf.has(sessionId)) fairnessKeyOf.set(sessionId, fairnessKey);
  queued.add(sessionId);
  queue.push(sessionId);
  admissionQueueDepth.set(queue.length);
}

/**
 * Force the session to the FRONT — even if some other path (wakeContainer's
 * own capacity rejection re-enqueues at the tail) already queued it. Without
 * the force-move, the dedupe would silently leave it at the back and the
 * "keeps its turn" promise would never actually hold (red-team finding).
 */
function requeueFront(sessionId: string): void {
  const at = queue.indexOf(sessionId);
  if (at !== -1) queue.splice(at, 1);
  queued.add(sessionId);
  queue.unshift(sessionId);
  admissionQueueDepth.set(queue.length);
}

/**
 * Take the next session to admit: the queued entry whose fairness bucket
 * currently holds the FEWEST slots, ties broken by queue position.
 *
 * Plain FIFO was the previous rule, and under a fan-out it is a starvation
 * machine: one user whose frontdesk delegates to eight workers puts eight
 * entries in front of the next person to speak, so that person waits for eight
 * whole model turns to finish. Least-loaded-first interleaves them instead.
 *
 * Chosen over a token bucket deliberately: there is no rate to configure, no
 * refill period to tune, and no way to starve anyone — a bucket holding zero
 * slots always beats one holding any, and admitting a session immediately
 * raises its own bucket's count, so the buckets equalise instead of one
 * winning forever. The FIFO tiebreak keeps ordering exact within a bucket and
 * between equally-loaded buckets, so nothing about the old behaviour is lost
 * when there is no contention.
 *
 * O(queue) per admission, and the queue is bounded by the session count.
 */
function pop(slotsHeldBy?: (key: string) => number): string | undefined {
  if (queue.length === 0) return undefined;

  let at = 0;
  if (slotsHeldBy) {
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < queue.length; i++) {
      const key = fairnessKeyOf.get(queue[i]);
      // No recorded key means the entry was queued by a path that did not
      // supply one; treat it as unloaded so it is never pushed behind, rather
      // than guessing a bucket for it.
      const held = key === undefined ? 0 : slotsHeldBy(key);
      if (held < best) {
        best = held;
        at = i;
        if (best === 0) break; // cannot do better, and this is the FIRST such entry
      }
    }
  }

  const [id] = queue.splice(at, 1);
  if (id !== undefined) {
    queued.delete(id);
    admissionQueueDepth.set(queue.length);
  }
  return id;
}

export function admissionQueueSize(): number {
  return queue.length;
}

/** Test helper — the queue is module state. */
export function clearAdmissionQueue(): void {
  queue.length = 0;
  queued.clear();
  failCounts.clear();
  firstQueuedAt.clear();
  fairnessKeyOf.clear();
  admissionQueueDepth.set(0);
}

export interface AdmissionDeps {
  /** Central-DB session lookup. */
  getSession(id: string): Session | undefined;
  /** Is a container already running (or tracked) for this session? */
  isRunning(session: Session): boolean;
  /** Does this session still have due (trigger-eligible) messages? */
  hasDueWork(session: Session): boolean;
  /** wakeContainer — never throws, false = rejected/failed. */
  wake(session: Session): Promise<boolean>;
  /** How many concurrency slots this fairness bucket currently holds. */
  slotsHeldBy(key: string): number;
}

/** Observe the total queue wait for a session that actually got a slot. */
function observeWait(sessionId: string): void {
  const since = firstQueuedAt.get(sessionId);
  if (since === undefined) return;
  firstQueuedAt.delete(sessionId);
  fairnessKeyOf.delete(sessionId);
  admissionWaitSeconds.observe((Date.now() - since) / 1000);
}

function recordFailure(sessionId: string): void {
  const n = (failCounts.get(sessionId) ?? 0) + 1;
  if (n === 1) {
    // Most likely a lost slot race — keep the turn.
    failCounts.set(sessionId, n);
    requeueFront(sessionId);
    return;
  }
  if (n < MAX_ADMISSION_FAILURES) {
    // Repeat failure smells like a per-session problem (bad config, torn
    // dir): rotate to the back so it cannot starve everyone behind it.
    failCounts.set(sessionId, n);
    enqueueAdmission(sessionId);
    return;
  }
  // Persistent failure: evict — the sweep re-wakes it on its own cadence,
  // and the operator sees the eviction. Keeping it queued would burn every
  // freed slot's single admission attempt on a session that cannot boot.
  failCounts.delete(sessionId);
  firstQueuedAt.delete(sessionId);
  fairnessKeyOf.delete(sessionId);
  log.warn('Admission queue: session evicted after repeated failed admissions — sweep owns its retries now', {
    sessionId,
    failures: n,
  });
}

/**
 * Admit the next queued session into the slot that just freed. One freed
 * slot = one admission attempt. Sessions that no longer need a container
 * (archived, already running, drained by the sweep in the meantime) are
 * skipped and the next candidate is tried in their place — skipping is not
 * an admission. A lookup failure drops that entry (the sweep is the
 * fallback) and moves on to the next candidate rather than wasting the slot.
 */
export function drainAdmissionSlot(deps: AdmissionDeps): void {
  for (;;) {
    const nextId = pop(deps.slotsHeldBy);
    if (!nextId) return;

    let candidate: Session | undefined;
    try {
      const next = deps.getSession(nextId);
      if (next && next.status === 'active' && !deps.isRunning(next) && deps.hasDueWork(next)) {
        candidate = next;
      }
    } catch (err) {
      log.warn('Admission drain: session probe failed — dropping the entry, sweep owns it', {
        sessionId: nextId,
        err,
      });
      failCounts.delete(nextId);
      firstQueuedAt.delete(nextId);
      fairnessKeyOf.delete(nextId);
      continue; // this slot can still admit the next candidate
    }
    if (!candidate) {
      failCounts.delete(nextId);
      firstQueuedAt.delete(nextId);
      fairnessKeyOf.delete(nextId);
      continue; // stale entry — try the next one
    }

    const admitted = candidate;
    void deps
      .wake(admitted)
      .then((ok) => {
        if (ok) {
          failCounts.delete(admitted.id);
          admissionAdmittedTotal.inc();
          observeWait(admitted.id);
        } else {
          recordFailure(admitted.id);
        }
      })
      .catch(() => {
        recordFailure(admitted.id);
      });
    return; // one admission attempt per freed slot
  }
}

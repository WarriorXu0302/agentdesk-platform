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

/** Consecutive failed admissions before a session is evicted to the sweep. */
const MAX_ADMISSION_FAILURES = 3;

export function enqueueAdmission(sessionId: string): void {
  if (queued.has(sessionId)) return;
  if (!firstQueuedAt.has(sessionId)) firstQueuedAt.set(sessionId, Date.now());
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

function pop(): string | undefined {
  const id = queue.shift();
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
}

/** Observe the total queue wait for a session that actually got a slot. */
function observeWait(sessionId: string): void {
  const since = firstQueuedAt.get(sessionId);
  if (since === undefined) return;
  firstQueuedAt.delete(sessionId);
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
    const nextId = pop();
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
      continue; // this slot can still admit the next candidate
    }
    if (!candidate) {
      failCounts.delete(nextId);
      firstQueuedAt.delete(nextId);
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

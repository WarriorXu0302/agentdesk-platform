/**
 * Admission queue for container wakes (concurrency stage 0 — service
 * direction, see the ADR-0058 context).
 *
 * Problem: when the global container cap rejects a wake, the session used to
 * wait for the next host-sweep tick — up to 60 seconds of queueing latency
 * per hop, which is a service-killer under load. This queue makes slot
 * handoff EVENT-DRIVEN: a capacity-rejected session enqueues here, and every
 * freed slot (container exit) admits the head immediately.
 *
 * The sweep remains the belt to this suspender: it still re-wakes any due
 * session on its tick, so a queue bug can delay a wake but never strand one.
 * Both paths funnel through wakeContainer, which is idempotent per session
 * (already-running → true; in-flight → joins the existing promise).
 *
 * FIFO with dedupe; bounded by the number of sessions by construction (a
 * session id enqueues at most once until popped).
 *
 * The drain logic takes its dependencies as a parameter so the queue's
 * behavior is unit-testable without Docker, the central DB, or session dirs.
 */
import { admissionAdmittedTotal, admissionQueueDepth } from './metrics.js';
import { log } from './log.js';
import type { Session } from './types.js';

const queue: string[] = [];
const queued = new Set<string>();

export function enqueueAdmission(sessionId: string): void {
  if (queued.has(sessionId)) return;
  queued.add(sessionId);
  queue.push(sessionId);
  admissionQueueDepth.set(queue.length);
}

/** Re-queue at the FRONT — a popped session whose wake re-rejected keeps its turn. */
function requeueFront(sessionId: string): void {
  if (queued.has(sessionId)) return;
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
  admissionQueueDepth.set(0);
}

export interface AdmissionDeps {
  /** Central-DB session lookup. */
  getSession(id: string): Session | undefined;
  /** Does this session still have due (trigger-eligible) messages? */
  hasDueWork(session: Session): boolean;
  /** wakeContainer — never throws, false = rejected/failed. */
  wake(session: Session): Promise<boolean>;
}

/**
 * Admit the next queued session into the slot that just freed. One freed
 * slot = one admission attempt: a pop whose wake re-rejects (lost a race for
 * the slot) goes back to the FRONT and waits for the next event. Sessions
 * that no longer need a container (archived, drained by the sweep in the
 * meantime) are skipped and the next candidate is tried in their place —
 * skipping is not an admission.
 */
export function drainAdmissionSlot(deps: AdmissionDeps): void {
  for (;;) {
    const nextId = pop();
    if (!nextId) return;

    let next: Session | undefined;
    let due = false;
    try {
      next = deps.getSession(nextId);
      due = Boolean(next && next.status === 'active' && deps.hasDueWork(next));
    } catch (err) {
      // Lookup trouble (DB closing during shutdown, torn session dir): drop
      // this entry — the sweep re-wakes anything real on its next tick.
      log.warn('Admission drain: session lookup failed — leaving it to the sweep', { sessionId: nextId, err });
      return;
    }
    if (!next || !due) continue; // stale entry — try the next candidate

    const candidate = next;
    void deps
      .wake(candidate)
      .then((ok) => {
        if (ok) {
          admissionAdmittedTotal.inc();
        } else {
          // Lost the slot race or spawn failed: keep its turn for the next
          // freed slot; the sweep remains the retry of last resort.
          requeueFront(candidate.id);
        }
      })
      .catch(() => {
        requeueFront(candidate.id);
      });
    return; // one admission attempt per freed slot
  }
}

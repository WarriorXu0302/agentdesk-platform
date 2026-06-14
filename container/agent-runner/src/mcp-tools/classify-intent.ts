/**
 * classify_intent — frontdesk-side intent classifier.
 *
 * Philosophy: classification is an explicit, observable step. Without
 * this tool, frontdesk classifies silently in its head and the host has
 * no way to see what it decided or why. With it, every routing decision
 * is a structured record: recommended worker, confidence, candidates
 * considered, reasoning, and the action taken (delegate / clarify /
 * reject / answer_self).
 *
 * The tool is NOT the router. It emits a classification event; the
 * agent still has to decide what to actually do next (call
 * send_message to the worker, or ask_user_question, or reply directly).
 * Keeping these as two separate steps is the whole point — you can
 * audit and A/B-test classification without side effects.
 *
 * Host side: see src/modules/classification-log/index.ts for the
 * delivery-action handler that persists these into classification_log.
 */
import { getConfig } from '../config.js';
import { getCurrentClassificationId, setCurrentClassificationId } from '../current-batch.js';
import { findByName } from '../destinations.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getRequestIdentity } from '../request-context.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `classify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Stable id that frontdesk returns to the agent, and that send_message /
 * ask_user_question later accept as `classificationId` to close the loop.
 * Distinct from the outbound row id so the schema doesn't leak the
 * storage layer. Shape chosen so it sorts lexicographically by time.
 */
function generateClassificationId(): string {
  return `cls-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Lightweight rule: how should the agent interpret its own confidence?
 * Returned as part of the tool response so the prompt can just read the
 * advisory instead of re-deriving the thresholds in natural language.
 *
 * Thresholds are conservative: enterprise routing accuracy costs more
 * than a brief extra clarification, so we nudge frontdesk toward
 * `ask_user_question` below 0.70.
 */
export const DEFAULT_CLARIFY_THRESHOLD = 0.7;
const MODERATE_CEILING = 0.85;

/**
 * `clarifyBelow` is the per-group clarify threshold (roadmap 2.4): below it,
 * the advisory pushes the frontdesk to ask_user_question before delegating. It
 * defaults to 0.70 and can be raised (stricter group) or lowered (looser group)
 * via container.json `confidenceThreshold`. The moderate-confidence band runs
 * from `clarifyBelow` up to a fixed 0.85 ceiling.
 */
export function confidenceAdvisory(
  confidence: number,
  candidateCount: number,
  clarifyBelow: number = DEFAULT_CLARIFY_THRESHOLD,
): string {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return 'Invalid confidence — treat this as low and ask the user to clarify.';
  }
  if (candidateCount === 0) {
    return 'No candidate workers identified — ask the user to clarify or reject politely.';
  }
  const t = clarifyBelow.toFixed(2);
  if (candidateCount > 1 && confidence < clarifyBelow) {
    return `Multiple plausible workers and confidence below ${t} — call ask_user_question before delegating.`;
  }
  if (confidence < clarifyBelow) {
    return `Confidence below ${t} — call ask_user_question before delegating.`;
  }
  if (confidence < MODERATE_CEILING) {
    return 'Confidence is moderate. Delegate, but consider adding a brief one-line confirmation in your reply so the user can catch a misroute.';
  }
  return 'High confidence — delegate directly.';
}

/** Read the per-group clarify threshold from config, falling back safely (the
 * config singleton isn't loaded in some test/non-runtime contexts). */
function clarifyThreshold(): number {
  try {
    return getConfig().confidenceThreshold ?? DEFAULT_CLARIFY_THRESHOLD;
  } catch {
    return DEFAULT_CLARIFY_THRESHOLD;
  }
}

export const classifyIntent: McpToolDefinition = {
  tool: {
    name: 'classify_intent',
    description:
      'Declare how you classified the user request before routing. Required before send_message to a worker, ' +
      'before ask_user_question used as a clarification, or before replying yourself. ' +
      'The tool records the decision (recommended worker, confidence, candidates considered, reasoning, action) ' +
      'into the central classification log, and returns a short advisory describing whether the confidence ' +
      'is high enough to delegate or whether you should clarify first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        userMessage: {
          type: 'string',
          description: 'The user message you are classifying (a short excerpt is fine).',
        },
        recommendedWorker: {
          type: 'string',
          description:
            'Single best-match worker destination name, or null when no worker fits (in which case either answer ' +
            'directly or clarify). Must be a real destination from your current destinations list.',
        },
        confidence: {
          type: 'number',
          description: 'Your confidence in `recommendedWorker` as a number in [0, 1].',
        },
        candidates: {
          type: 'array',
          items: { type: 'string' },
          description: 'Other worker destinations you considered, in descending order of plausibility.',
        },
        reasoning: {
          type: 'string',
          description:
            'One or two sentences explaining why you picked `recommendedWorker` (or why none fit). Stored ' +
            'for later audit and regression testing.',
        },
        action: {
          type: 'string',
          enum: ['delegate', 'clarify', 'reject', 'answer_self'],
          description:
            'What you intend to do next with this classification: `delegate` (call send_message to the worker), ' +
            '`clarify` (call ask_user_question first), `reject` (politely decline), or `answer_self` (reply ' +
            'directly without routing).',
        },
      },
      required: ['userMessage', 'confidence', 'action'],
    },
  },
  async handler(args) {
    const userMessage = typeof args.userMessage === 'string' ? args.userMessage : '';
    const recommendedWorker =
      typeof args.recommendedWorker === 'string' && args.recommendedWorker.length > 0 ? args.recommendedWorker : null;
    const confidenceRaw = args.confidence;
    const confidence = typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw) ? confidenceRaw : Number.NaN;
    const candidatesRaw = args.candidates;
    const candidates = Array.isArray(candidatesRaw)
      ? candidatesRaw.filter((c): c is string => typeof c === 'string' && c.length > 0)
      : [];
    const reasoning = typeof args.reasoning === 'string' ? args.reasoning : null;
    const actionRaw = args.action;
    const action =
      typeof actionRaw === 'string' && ['delegate', 'clarify', 'reject', 'answer_self'].includes(actionRaw)
        ? (actionRaw as 'delegate' | 'clarify' | 'reject' | 'answer_self')
        : null;
    if (!action) return err('action must be one of delegate | clarify | reject | answer_self');
    if (!userMessage) return err('userMessage is required');
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return err('confidence must be a finite number in [0, 1]');
    }
    // Validate recommendedWorker against the local destinations table
    // when it's declared: the prompt already told the LLM to use only
    // real destination names, but nothing enforced it — random strings
    // would pollute the regression corpus as "delegate to finace-worke"
    // typos. delegate / clarify without a destination-backed
    // recommendation are still allowed (the LLM may genuinely not pick
    // one yet); reject / answer_self naturally have no worker.
    if (recommendedWorker) {
      const dest = findByName(recommendedWorker);
      if (!dest || dest.type !== 'agent') {
        return err(
          `recommendedWorker "${recommendedWorker}" is not a known agent destination. Use one of your configured worker names, or omit this field if you won't be delegating.`,
        );
      }
    }

    const identity = getRequestIdentity();
    const classificationId = generateClassificationId();

    // De-duplicate candidates so a reviewer counting "multiple plausible
    // workers" can't be fooled by the LLM listing recommendedWorker both
    // as top pick and in the candidates array. This also tightens the
    // confidenceAdvisory() branch that triggers on > 1 candidates.
    const distinctCandidates = Array.from(new Set([...(recommendedWorker ? [recommendedWorker] : []), ...candidates]));

    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'classify_intent',
        classificationId,
        userId: identity?.userId ?? null,
        // Preserve the full channel/thread context on the audit row.
        // Without these, later analytics can't slice "what did
        // frontdesk classify in this thread / this channel" without
        // awkward joins.
        channelType: identity?.channelType ?? null,
        platformId: identity?.platformId ?? null,
        threadId: identity?.threadId ?? null,
        userMessage: userMessage.slice(0, 500),
        recommendedWorker,
        confidence,
        candidates: distinctCandidates,
        reasoning,
        action_taken: action,
      }),
    });

    // Publish to per-turn state so final <message to="..."> dispatch
    // can auto-stamp the outbound row. LLMs can't embed the id into
    // the XML form, so without this, every delegation via the main
    // <message> protocol would bypass the classification audit loop.
    // Last-write-wins is fine: multiple classify_intent calls in one
    // turn mean the agent re-classified, and only the latest view
    // should be attributed to the eventual send.
    setCurrentClassificationId(classificationId);

    const advisory = confidenceAdvisory(confidence, distinctCandidates.length, clarifyThreshold());
    log(
      `classify_intent: id=${classificationId} worker=${recommendedWorker ?? 'none'} conf=${confidence.toFixed(2)} action=${action}`,
    );
    // Return structure instead of a plain string. The advisory stays at
    // the top for natural-language salience; the id is informational —
    // the agent does NOT need to remember or re-pass it because the
    // runner auto-attaches it to subsequent outbound (including the
    // final <message to="..."> XML path, which has no explicit arg).
    return ok(
      `${advisory}\n\nclassificationId: ${classificationId} (auto-attached to your next outbound; you don't need to quote it back).`,
    );
  },
};

/**
 * escalate_to_human (ADR-0038, roadmap 2.3) — a SEPARATE decision from
 * classify_intent. classify_intent picks a worker; this hands the request OUT of
 * the AI flow to a person. Emits an orthogonal `escalate` system action (never a
 * classify_intent action value) carrying reason + urgency. The host records it
 * (classification_log + enterprise_audit + escalation_total); the operator's
 * backend owns the actual routing/priority — so the agent must still tell the
 * user it is handing off.
 */
export const escalateToHuman: McpToolDefinition = {
  tool: {
    name: 'escalate_to_human',
    description:
      'Hand the current request OFF to a human when you cannot safely or competently handle it — distinct from delegating to another worker agent. ' +
      'Records an explicit, audited escalation (reason + urgency) so operators can track handoff rate and SLA. ' +
      'The platform records the intent; your operator’s backend decides who receives it and how urgent items are prioritized — so still tell the user you are bringing in a person. ' +
      'Identity is taken from the active session by the runtime.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description:
            'Why this needs a human — short and specific. Use your team’s reason vocabulary if one is defined.',
        },
        urgency: {
          type: 'string',
          enum: ['low', 'medium', 'high', 'critical'],
          description: 'How time-sensitive the handoff is. Default: medium.',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!reason) return err('reason is required to escalate');
    const urgency = typeof args.urgency === 'string' ? args.urgency : 'medium';
    const identity = getRequestIdentity();

    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'escalate',
        userId: identity?.userId ?? null,
        channelType: identity?.channelType ?? null,
        platformId: identity?.platformId ?? null,
        threadId: identity?.threadId ?? null,
        escalation_reason: reason.slice(0, 500),
        urgency_level: urgency,
      }),
    });

    log(`escalate_to_human: urgency=${urgency} reason="${reason.slice(0, 60)}"`);
    return ok(
      `Escalation recorded (urgency: ${urgency}). A person will be brought in per your operator’s routing — let the user know you’re handing off to a human.`,
    );
  },
};

/**
 * report_routing_feedback (ADR-0040, roadmap 2.1 misroute + 2.5 nack) — a worker
 * tells the platform "this should have gone elsewhere" (misroute) or "I'm
 * rejecting this turn" (nack). It is a RECORDING signal, not a routing primitive:
 * the host logs it (classification_log + enterprise_audit + a metric) for
 * operator dashboards and routing tuning, and does NOT re-send the message
 * anywhere — active reroute was rejected in ADR-0040 (it belongs in the operator
 * gateway). So the worker must STILL reply normally / hand the turn back.
 *
 * Emits an orthogonal `routing_feedback` system action (never a classify_intent /
 * escalate value). It attaches the current classificationId (the host runtime
 * carries it across the a2a hop) so operators can join this feedback back to
 * frontdesk's original routing decision.
 */
export const reportRoutingFeedback: McpToolDefinition = {
  tool: {
    name: 'report_routing_feedback',
    description:
      'Flag that the request you just received was MISROUTED (should have gone to a different worker) or that you are NACKing it (cannot/should not handle it this turn). ' +
      'This RECORDS a signal for operators and future routing tuning — it does NOT re-send your message anywhere. ' +
      'So if you cannot handle the request, you must STILL reply normally (e.g. tell the user/frontdesk, or hand back) — do not assume the platform reroutes it. ' +
      'Identity is taken from the active session by the runtime.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['misroute', 'nack'],
          description:
            "'misroute' = this should have gone to a different worker; 'nack' = I am rejecting/cannot handle this turn.",
        },
        reason: {
          type: 'string',
          description: 'Why — short and specific. Recorded for operators; never used to route.',
        },
        suggestedTarget: {
          type: 'string',
          description:
            'Optional: the worker you think this should have gone to. A HINT for operators only — the platform does NOT resolve or route to it.',
        },
      },
      required: ['kind'],
      additionalProperties: false,
    },
  },
  async handler(args) {
    const kind = typeof args.kind === 'string' ? args.kind : '';
    if (kind !== 'misroute' && kind !== 'nack') return err("kind must be 'misroute' or 'nack'");
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    const suggestedTarget = typeof args.suggestedTarget === 'string' ? args.suggestedTarget.trim() : '';
    const identity = getRequestIdentity();

    writeMessageOut({
      id: generateId(),
      kind: 'system',
      content: JSON.stringify({
        action: 'routing_feedback',
        feedback_kind: kind,
        userId: identity?.userId ?? null,
        channelType: identity?.channelType ?? null,
        platformId: identity?.platformId ?? null,
        threadId: identity?.threadId ?? null,
        // Correlate back to frontdesk's original classify decision for this work
        // (host runtime carries the id across the a2a hop). Recording-only hint.
        classificationId: getCurrentClassificationId(),
        feedback_reason: reason ? reason.slice(0, 500) : null,
        suggested_target: suggestedTarget ? suggestedTarget.slice(0, 120) : null,
      }),
    });

    log(`report_routing_feedback: kind=${kind} suggested="${suggestedTarget.slice(0, 40)}"`);
    return ok(
      `Routing feedback recorded (${kind}). The platform will NOT reroute this — still reply to the user or hand the turn back so the request isn't dropped.`,
    );
  },
};

registerTools([classifyIntent, escalateToHuman, reportRoutingFeedback]);

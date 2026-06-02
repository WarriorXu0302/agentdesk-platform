/**
 * Bootstrap a shared-enterprise FrontLane topology.
 *
 * Creates/reuses a primary frontdesk agent group, an optional secondary
 * lab-style frontdesk (Phase 0a `frontlane-lab-frontdesk`), plus a set of
 * specialist workers for the primary frontdesk. Seeds group files with
 * enterprise-oriented starter instructions, wires bidirectional agent
 * destinations, and optionally wires a shared entry channel to the
 * **primary** frontdesk.
 *
 * Multi-frontdesk model (see ADR-0008):
 * - DEFAULT_FRONTDESKS lists every desk this script provisions by default.
 * - The first entry is the "primary" frontdesk: shared-entry wiring + worker
 *   reverse destinations attach here.
 * - Subsequent desks (e.g. lab) own their own `groups/<folder>/` prompt
 *   contract and call the ERP gateway directly; they do not delegate to
 *   shared workers, so they get `workers: []` and contribute no reverse
 *   destinations on existing workers (avoids destination-name collisions).
 * - Passing --frontdesk-folder or --frontdesk-name switches to single-desk
 *   mode for back-compat with older callers.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-enterprise-topology.ts
 *
 *   pnpm exec tsx scripts/init-enterprise-topology.ts \
 *     --channel feishu \
 *     --platform-id oc_xxx \
 *     --group-name "FrontLane Template Desk" \
 *     --threaded
 *
 * Optional args:
 *   --frontdesks folder1:name1[,folder2:name2,...]    # multi-desk override
 *   --frontdesk-name "FrontLane Template Desk"        # single-desk back-compat
 *   --frontdesk-folder frontlane-template-frontdesk   # single-desk back-compat
 *   --workers access-worker,sales-worker,finance-worker,approval-worker,ops-worker
 *   --channel <channel>
 *   --platform-id <platform id emitted by the adapter>
 *   --group-name <messaging-group display name>
 *   --session-mode shared|per-thread|agent-shared|per-user|per-user-per-thread
 *   --engage-mode pattern|mention|mention-sticky
 *   --sender-scope all|known
 *   --unknown-sender-policy strict|request_approval|public
 *   --threaded   # default shared-group mode becomes per-user-per-thread
 *   --dm         # treat the wired surface as a 1:1 DM instead of a group
 */
import path from 'path';
import { fileURLToPath } from 'url';

import {
  buildLegacyWorkerFolder,
  buildWorkerFolder,
  DEFAULT_FRONTDESK_FOLDER,
  DEFAULT_FRONTDESK_NAME,
  LEGACY_FRONTDESK_FOLDER,
} from '../src/branding.js';
import { DATA_DIR } from '../src/config.js';
import { updateContainerConfig } from '../src/container-config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { closeDb, initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
  updateMessagingGroupAgent,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getSessionsByAgentGroup } from '../src/db/sessions.js';
import { initGroupFilesystem } from '../src/group-init.js';
import {
  createDestination,
  getDestinationByName,
  normalizeName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../src/modules/agent-to-agent/write-destinations.js';
import { namespacedPlatformId } from '../src/platform-id.js';
import type {
  AgentGroup,
  MessagingGroup,
  MessagingGroupAgent,
  SenderScope,
  UnknownSenderPolicy,
} from '../src/types.js';

const DEFAULT_WORKERS = ['access-worker', 'sales-worker', 'finance-worker', 'approval-worker', 'ops-worker'];
const FRONTDESK_DESTINATION_NAME = 'frontdesk';
const SESSION_MODES: MessagingGroupAgent['session_mode'][] = [
  'shared',
  'per-thread',
  'agent-shared',
  'per-user',
  'per-user-per-thread',
];
const ENGAGE_MODES: MessagingGroupAgent['engage_mode'][] = ['pattern', 'mention', 'mention-sticky'];
const SENDER_SCOPES: SenderScope[] = ['all', 'known'];
const UNKNOWN_SENDER_POLICIES: UnknownSenderPolicy[] = ['strict', 'request_approval', 'public'];

/**
 * One frontdesk specification. `workers` may be empty — secondary desks
 * (like the Phase 0a lab frontdesk) call the ERP gateway directly and do
 * not own a shared worker pool. Only the **primary** frontdesk (the first
 * entry in the active list) wires reverse `frontdesk` destinations onto
 * workers, to avoid name collisions on the worker side.
 */
interface FrontdeskSpec {
  folder: string;
  name: string;
  workers: string[];
}

/**
 * Default desks provisioned by `pnpm init:enterprise` with no args.
 * Order is significant: index 0 is the primary frontdesk.
 *
 * `frontlane-lab-frontdesk` was added in Phase 0a (ADR-0008) as a
 * lab-flavored secondary desk that owns its own prompt contract
 * (`groups/frontlane-lab-frontdesk/CLAUDE.local.md`) and calls the ERP
 * gateway directly — hence `workers: []`.
 */
const DEFAULT_FRONTDESKS: FrontdeskSpec[] = [
  {
    folder: DEFAULT_FRONTDESK_FOLDER,
    name: DEFAULT_FRONTDESK_NAME,
    workers: DEFAULT_WORKERS,
  },
  {
    folder: 'frontlane-lab-frontdesk',
    name: 'FrontLane Lab Desk',
    workers: [],
  },
];

interface Args {
  /**
   * Active frontdesk list after CLI parsing. May be a single-element list
   * (single-desk back-compat mode triggered by --frontdesk-folder or
   * --frontdesk-name) or the multi-desk default.
   */
  frontdesks: FrontdeskSpec[];
  channel: string | null;
  platformId: string | null;
  groupName: string | null;
  sessionMode: MessagingGroupAgent['session_mode'] | null;
  engageMode: MessagingGroupAgent['engage_mode'] | null;
  senderScope: SenderScope;
  unknownSenderPolicy: UnknownSenderPolicy;
  isGroup: boolean;
  threaded: boolean;
}

interface WorkerSpec {
  localName: string;
  displayName: string;
  folder: string;
  description: string;
}

function parseArgs(argv: string[]): Args {
  let singleFrontdeskName: string | undefined;
  let singleFrontdeskFolder: string | undefined;
  let frontdesksRaw: string | undefined;
  let workersRaw: string | undefined;
  let channel: string | undefined;
  let platformId: string | undefined;
  let groupName: string | undefined;
  let sessionMode: MessagingGroupAgent['session_mode'] | undefined;
  let engageMode: MessagingGroupAgent['engage_mode'] | undefined;
  let senderScope: SenderScope = 'all';
  let unknownSenderPolicy: UnknownSenderPolicy = 'strict';
  let isGroup = true;
  let threaded = false;
  let sawChannelConfig = false;
  let sawSingleFrontdesk = false;

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--frontdesk-name':
        singleFrontdeskName = val;
        sawSingleFrontdesk = true;
        i++;
        break;
      case '--frontdesk-folder':
        singleFrontdeskFolder = val;
        sawSingleFrontdesk = true;
        i++;
        break;
      case '--frontdesks':
        frontdesksRaw = val;
        i++;
        break;
      case '--workers':
        workersRaw = val;
        i++;
        break;
      case '--channel':
        channel = (val ?? '').toLowerCase();
        i++;
        break;
      case '--platform-id':
        platformId = val;
        i++;
        break;
      case '--group-name':
        groupName = val;
        sawChannelConfig = true;
        i++;
        break;
      case '--session-mode':
        if (!SESSION_MODES.includes((val ?? '') as MessagingGroupAgent['session_mode'])) {
          fatal(`Invalid --session-mode: ${val} (expected ${SESSION_MODES.join(', ')})`);
        }
        sessionMode = val as MessagingGroupAgent['session_mode'];
        sawChannelConfig = true;
        i++;
        break;
      case '--engage-mode':
        if (!ENGAGE_MODES.includes((val ?? '') as MessagingGroupAgent['engage_mode'])) {
          fatal(`Invalid --engage-mode: ${val} (expected ${ENGAGE_MODES.join(', ')})`);
        }
        engageMode = val as MessagingGroupAgent['engage_mode'];
        sawChannelConfig = true;
        i++;
        break;
      case '--sender-scope':
        if (!SENDER_SCOPES.includes((val ?? '') as SenderScope)) {
          fatal(`Invalid --sender-scope: ${val} (expected ${SENDER_SCOPES.join(', ')})`);
        }
        senderScope = val as SenderScope;
        sawChannelConfig = true;
        i++;
        break;
      case '--unknown-sender-policy':
        if (!UNKNOWN_SENDER_POLICIES.includes((val ?? '') as UnknownSenderPolicy)) {
          fatal(`Invalid --unknown-sender-policy: ${val} (expected ${UNKNOWN_SENDER_POLICIES.join(', ')})`);
        }
        unknownSenderPolicy = val as UnknownSenderPolicy;
        sawChannelConfig = true;
        i++;
        break;
      case '--threaded':
        threaded = true;
        sawChannelConfig = true;
        break;
      case '--dm':
        isGroup = false;
        sawChannelConfig = true;
        break;
      default:
        if (key.startsWith('--')) {
          fatal(`Unknown arg: ${key}`);
        }
        break;
    }
  }

  if ((channel && !platformId) || (!channel && platformId)) {
    fatal('Provide both --channel and --platform-id when wiring a shared entry surface.');
  }
  if (!channel && sawChannelConfig) {
    fatal('Pass --channel (and --platform-id) when using shared-entry wiring options.');
  }
  if (!isGroup && threaded) {
    fatal('--threaded only makes sense for shared/group surfaces; remove it when using --dm.');
  }
  if (sawSingleFrontdesk && frontdesksRaw) {
    fatal('Use either --frontdesks (multi-desk) or --frontdesk-folder/--frontdesk-name (single-desk), not both.');
  }

  const workers = parseWorkers(workersRaw);
  const frontdesks = resolveFrontdesks({
    sawSingleFrontdesk,
    singleFrontdeskFolder,
    singleFrontdeskName,
    frontdesksRaw,
    primaryWorkers: workers,
  });

  return {
    frontdesks,
    channel: channel ?? null,
    platformId: platformId?.trim() || null,
    groupName: groupName?.trim() || null,
    sessionMode: sessionMode ?? null,
    engageMode: engageMode ?? null,
    senderScope,
    unknownSenderPolicy,
    isGroup,
    threaded,
  };
}

/**
 * Resolve the active frontdesk list from CLI flags.
 *
 * Precedence:
 * 1. Single-desk back-compat: `--frontdesk-folder` and/or `--frontdesk-name`
 *    yields a single-desk list using the CLI-provided values (folder/name)
 *    or the standard defaults if not given. Primary desk inherits the
 *    `--workers` override.
 * 2. Explicit multi-desk: `--frontdesks folder1:name1,folder2:name2` yields
 *    that exact list. First entry inherits `--workers`; the rest are
 *    `workers: []`.
 * 3. Default: `DEFAULT_FRONTDESKS` (primary inherits `--workers`).
 */
function resolveFrontdesks(opts: {
  sawSingleFrontdesk: boolean;
  singleFrontdeskFolder: string | undefined;
  singleFrontdeskName: string | undefined;
  frontdesksRaw: string | undefined;
  primaryWorkers: string[];
}): FrontdeskSpec[] {
  if (opts.sawSingleFrontdesk) {
    return [
      {
        folder: normalizeName(opts.singleFrontdeskFolder?.trim() || DEFAULT_FRONTDESK_FOLDER),
        name: opts.singleFrontdeskName?.trim() || DEFAULT_FRONTDESK_NAME,
        workers: opts.primaryWorkers,
      },
    ];
  }

  if (opts.frontdesksRaw) {
    const list = parseFrontdesksList(opts.frontdesksRaw, opts.primaryWorkers);
    if (list.length === 0) fatal('--frontdesks parsed to an empty list.');
    return list;
  }

  return DEFAULT_FRONTDESKS.map((desk, idx) => ({
    folder: desk.folder,
    name: desk.name,
    // The primary desk picks up the operator's --workers override; other
    // desks keep their declared (typically empty) worker set.
    workers: idx === 0 ? opts.primaryWorkers : desk.workers,
  }));
}

/** Parse `folder1:name1[,folder2:name2,...]`. Empty `:name` parts default to titleCase(folder). */
function parseFrontdesksList(raw: string, primaryWorkers: string[]): FrontdeskSpec[] {
  const seen = new Set<string>();
  const result: FrontdeskSpec[] = [];
  for (const [idx, part] of raw.split(',').entries()) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    const folderRaw = colon >= 0 ? trimmed.slice(0, colon).trim() : trimmed;
    const nameRaw = colon >= 0 ? trimmed.slice(colon + 1).trim() : '';
    const folder = normalizeName(folderRaw);
    if (!folder) fatal(`--frontdesks entry has empty folder: "${trimmed}"`);
    if (seen.has(folder)) fatal(`--frontdesks duplicate folder: "${folder}"`);
    seen.add(folder);
    result.push({
      folder,
      name: nameRaw || titleCase(folder),
      workers: idx === 0 ? primaryWorkers : [],
    });
  }
  return result;
}

function parseWorkers(raw: string | undefined): string[] {
  const source = raw?.trim() || DEFAULT_WORKERS.join(',');
  const workers = source
    .split(',')
    .map((part) => normalizeName(part.trim()))
    .filter(Boolean);
  if (workers.length === 0) {
    fatal('Worker list is empty. Pass --workers with at least one worker name.');
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const worker of workers) {
    if (worker === FRONTDESK_DESTINATION_NAME) {
      fatal(`Worker name "${worker}" is reserved.`);
    }
    if (seen.has(worker)) continue;
    seen.add(worker);
    unique.push(worker);
  }
  return unique;
}

function fatal(message: string): never {
  console.error(message);
  console.error('See scripts/init-enterprise-topology.ts header for usage.');
  process.exit(2);
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function titleCase(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function describeWorker(localName: string): string {
  switch (localName) {
    case 'access-worker':
      return 'identity resolution, authentication state, and permission scope checks';
    case 'sales-worker':
      return 'sales CRM, quotes, customer follow-up, and order intake';
    case 'finance-worker':
      return 'billing, invoices, reconciliation, payment status, and account balances';
    case 'approval-worker':
      return 'approval policies, privileged-action gating, and human confirmation flows';
    case 'ops-worker':
      return 'ERP operations, ticket triage, backend exception handling, and runbook work';
    case 'research-worker':
      return 'read-only lookup, drafting, and summarization work';
    default:
      return 'specialist ERP and business process handling for its assigned domain';
  }
}

function buildWorkerSpecs(localNames: string[]): WorkerSpec[] {
  return localNames.map((localName) => ({
    localName,
    displayName: `FrontLane ${titleCase(localName)}`,
    folder: normalizeName(buildWorkerFolder(localName)),
    description: describeWorker(localName),
  }));
}

function buildFrontdeskInstructions(frontdeskName: string, workers: WorkerSpec[]): string {
  const workerDestinations = workers.map((worker) => `- \`${worker.localName}\`: ${worker.description}`).join('\n');

  return `# ${frontdeskName}

You are the shared frontdesk agent for an enterprise ERP assistant platform.

Primary responsibilities:
- greet the user and classify the business request
- keep each user's workstream isolated to the current session only
- verify the request has passed identity and permission checks before any ERP-side action
- delegate specialist work to the correct worker destination
- keep group-chat behavior low-risk: explain, summarize, and collect context there, but avoid sensitive irreversible writes

Available worker destinations:
${workerDestinations}

## Intent classification — REQUIRED

Before you do any of these things, call the \`classify_intent\` tool:
- delegating work to a worker (before calling \`send_message\` with an agent destination)
- asking the user to clarify their request
- declining a request
- answering the user yourself without routing

\`classify_intent\` records your decision (recommended worker, confidence in [0, 1], candidates considered, reasoning, and the action you intend to take) and returns a short advisory.

Follow the advisory:
- the advisory is authoritative — if it tells you to clarify, do not delegate until you have called \`ask_user_question\` and received a response
- thresholds: confidence < 0.70 OR multiple plausible workers → clarify first
- confidence 0.70-0.85 → delegate, but add a one-line confirmation in your reply so the user can catch a misroute
- confidence ≥ 0.85 → delegate directly

Never delegate silently. Every routing decision must have a preceding \`classify_intent\` call, so the platform can audit, measure, and regression-test your routing.

## Working rules

- if the request involves identity, entitlements, or permission ambiguity, route to \`access-worker\` first when available
- for money movement, approvals, status changes, or destructive operations, require explicit confirmation and use the approval path
- use <message to="worker-name">...</message> for delegation and include only the minimum context needed
- return concise user-facing summaries after worker results come back
`;
}

function buildSoloFrontdeskInstructions(frontdeskName: string): string {
  return `# ${frontdeskName}

You are a self-contained frontdesk agent. You receive user requests directly
and call the ERP gateway (\`erp_*\` tools) yourself, without delegating to
shared worker agents.

Operating rules:
- preserve session isolation: never read or write another user's session
- verify identity and permission scope before any ERP-side write
- for any operation that mutates physical or business state, require explicit
  user confirmation first
- never fabricate completion — return only results backed by a real tool
  response or file write
- when you cannot satisfy a request safely, say so and propose the next step
`;
}

function buildWorkerInstructions(worker: WorkerSpec): string {
  return `# ${worker.displayName}

You are ${worker.displayName}, a specialist worker behind a shared enterprise frontdesk agent.

Domain focus:
- ${worker.description}

Operating rules:
- messages arrive from the frontdesk agent, not directly from end users
- do not assume authorization for privileged ERP actions; require a verified permission result when needed
- ask for the smallest missing input set instead of broad open-ended follow-ups
- return structured, concise results back to <message to="${FRONTDESK_DESTINATION_NAME}">...</message>
- include clear blockers, approvals, and audit-relevant notes when the task changes business state
`;
}

/**
 * Conservative default container resource caps, applied when a new
 * agent group is created by this script. Each role gets a separate
 * budget so frontdesk (classify + delegate, light) stays smaller than
 * workers (may run tool calls / agent-browser / heavier reasoning).
 *
 * These are *defaults*: ensureAgentGroup only writes them when
 * container.json has no `resources` field yet. An operator who
 * hand-edits container.json or raises the caps later is never
 * overwritten by a script re-run.
 *
 * Without these, a runaway agent can exhaust host memory or fork-bomb
 * the kernel. See container-config.ts ContainerResourceLimits.
 */
type AgentRole = 'frontdesk' | 'worker';

const DEFAULT_RESOURCES: Record<AgentRole, { memoryMb: number; cpus: number; pidsLimit: number }> = {
  frontdesk: { memoryMb: 768, cpus: 1, pidsLimit: 384 },
  worker: { memoryMb: 1024, cpus: 1, pidsLimit: 512 },
};

function ensureAgentGroup(
  folder: string,
  name: string,
  instructions: string,
  now: string,
  role: AgentRole = 'worker',
): AgentGroup {
  let group = getAgentGroupByFolder(folder);
  if (!group && folder === DEFAULT_FRONTDESK_FOLDER) {
    group = getAgentGroupByFolder(LEGACY_FRONTDESK_FOLDER);
  }
  if (!group && folder.startsWith('frontlane-')) {
    const localName = folder.slice('frontlane-'.length);
    group = getAgentGroupByFolder(buildLegacyWorkerFolder(localName));
  }
  if (!group) {
    createAgentGroup({
      id: generateId('ag'),
      name,
      folder,
      agent_provider: null,
      created_at: now,
    });
    group = getAgentGroupByFolder(folder)!;
    console.log(`Created agent group: ${group.id} (${folder})`);
  } else {
    console.log(`Reusing agent group: ${group.id} (${folder})`);
  }

  initGroupFilesystem(group, { instructions });
  updateContainerConfig(group.folder, (config) => {
    config.a2aSessionMode = 'root-session';
    // Only fill resources when the operator hasn't set anything — never
    // clobber hand-tuned caps. Covers the "first-time init" case where a
    // new enterprise deployment otherwise runs unbounded.
    if (!config.resources) {
      config.resources = { ...DEFAULT_RESOURCES[role] };
    }
  });
  return group;
}

function ensureDestination(source: AgentGroup, target: AgentGroup, localName: string, now: string): boolean {
  const existingByName = getDestinationByName(source.id, localName);
  if (existingByName) {
    if (existingByName.target_type !== 'agent' || existingByName.target_id !== target.id) {
      throw new Error(`Destination collision: ${source.name} already uses "${localName}" for another target.`);
    }
    return false;
  }

  createDestination({
    agent_group_id: source.id,
    local_name: localName,
    target_type: 'agent',
    target_id: target.id,
    created_at: now,
  });
  return true;
}

function refreshDestinations(agentGroupId: string): void {
  for (const session of getSessionsByAgentGroup(agentGroupId)) {
    if (session.status !== 'active') continue;
    writeDestinations(agentGroupId, session.id);
  }
}

function ensureSharedEntryWiring(frontdesk: AgentGroup, args: Args, now: string): MessagingGroup | null {
  if (!args.channel || !args.platformId) return null;

  const engageMode = args.engageMode ?? (args.isGroup ? 'mention-sticky' : 'pattern');
  const sessionMode =
    args.sessionMode ?? (args.isGroup ? (args.threaded ? 'per-user-per-thread' : 'per-user') : 'shared');
  const engagePattern = engageMode === 'pattern' ? '.' : null;
  const platformId = namespacedPlatformId(args.channel, args.platformId);
  let messagingGroup = getMessagingGroupByPlatform(args.channel, platformId);
  if (!messagingGroup) {
    messagingGroup = {
      id: generateId('mg'),
      channel_type: args.channel,
      platform_id: platformId,
      name: args.groupName || frontdesk.name,
      is_group: args.isGroup ? 1 : 0,
      unknown_sender_policy: args.unknownSenderPolicy,
      created_at: now,
    };
    createMessagingGroup(messagingGroup);
    console.log(`Created messaging group: ${messagingGroup.id} (${platformId})`);
  } else {
    console.log(`Reusing messaging group: ${messagingGroup.id} (${platformId})`);
    const messagingGroupUpdates: Parameters<typeof updateMessagingGroup>[1] = {};
    if (args.groupName && messagingGroup.name !== args.groupName) {
      messagingGroupUpdates.name = args.groupName;
    }
    if (messagingGroup.is_group !== (args.isGroup ? 1 : 0)) {
      messagingGroupUpdates.is_group = args.isGroup ? 1 : 0;
    }
    if (messagingGroup.unknown_sender_policy !== args.unknownSenderPolicy) {
      messagingGroupUpdates.unknown_sender_policy = args.unknownSenderPolicy;
    }
    if (Object.keys(messagingGroupUpdates).length > 0) {
      updateMessagingGroup(messagingGroup.id, messagingGroupUpdates);
      messagingGroup = getMessagingGroupByPlatform(args.channel, platformId)!;
      console.log(`Updated messaging group settings: ${messagingGroup.id}`);
    }
  }

  const existing = getMessagingGroupAgentByPair(messagingGroup.id, frontdesk.id);
  if (!existing) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: messagingGroup.id,
      agent_group_id: frontdesk.id,
      engage_mode: engageMode,
      engage_pattern: engagePattern,
      sender_scope: args.senderScope,
      ignored_message_policy: 'drop',
      session_mode: sessionMode,
      priority: 0,
      created_at: now,
    });
    console.log(`Wired shared entry surface: ${messagingGroup.id} -> ${frontdesk.id} (${sessionMode}, ${engageMode})`);
  } else {
    const wiringUpdates: Parameters<typeof updateMessagingGroupAgent>[1] = {};
    if (existing.engage_mode !== engageMode) wiringUpdates.engage_mode = engageMode;
    if (existing.engage_pattern !== engagePattern) wiringUpdates.engage_pattern = engagePattern;
    if (existing.sender_scope !== args.senderScope) wiringUpdates.sender_scope = args.senderScope;
    if (existing.ignored_message_policy !== 'drop') wiringUpdates.ignored_message_policy = 'drop';
    if (existing.session_mode !== sessionMode) wiringUpdates.session_mode = sessionMode;
    if (existing.priority !== 0) wiringUpdates.priority = 0;

    if (Object.keys(wiringUpdates).length > 0) {
      updateMessagingGroupAgent(existing.id, wiringUpdates);
      console.log(`Updated shared entry wiring: ${existing.id} (${sessionMode}, ${engageMode}, ${args.senderScope})`);
    } else {
      console.log(`Shared entry wiring already exists: ${existing.id}`);
    }
  }

  return messagingGroup;
}

export async function run(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  closeDb();
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();
  const touchedGroups = new Set<string>();

  // Collision pre-check across all frontdesks and their workers — across the
  // *active* desk list. Each desk's workers are checked against that desk's
  // folder name; cross-desk folder collisions are also flagged.
  const allFolders = new Set<string>();
  for (const desk of args.frontdesks) {
    if (allFolders.has(desk.folder)) {
      throw new Error(`Duplicate frontdesk folder in active list: "${desk.folder}".`);
    }
    allFolders.add(desk.folder);
  }
  for (const desk of args.frontdesks) {
    for (const worker of desk.workers) {
      const workerFolder = normalizeName(buildWorkerFolder(worker));
      if (workerFolder === desk.folder) {
        throw new Error(
          `Frontdesk folder "${desk.folder}" collides with worker folder. Pick a different folder or worker name.`,
        );
      }
    }
  }

  // Primary (index 0) is the desk that owns shared workers and the optional
  // channel wiring. Secondary desks (e.g. lab) get their own agent_group +
  // group filesystem but no reverse worker destinations.
  const primaryDesk = args.frontdesks[0];

  // Build worker specs once (only used by primary desk).
  const primaryWorkerSpecs = buildWorkerSpecs(primaryDesk.workers);

  // 1. Provision every frontdesk in the active list.
  const frontdeskGroups: AgentGroup[] = [];
  for (const desk of args.frontdesks) {
    const isPrimary = desk === primaryDesk;
    const instructions = isPrimary
      ? buildFrontdeskInstructions(desk.name, primaryWorkerSpecs)
      : buildSoloFrontdeskInstructions(desk.name);
    const group = ensureAgentGroup(desk.folder, desk.name, instructions, now, 'frontdesk');
    frontdeskGroups.push(group);
  }
  const primaryFrontdeskGroup = frontdeskGroups[0];

  // 2. Provision primary desk's workers and wire bidirectional destinations.
  const workerGroups = primaryWorkerSpecs.map((worker) =>
    ensureAgentGroup(worker.folder, worker.displayName, buildWorkerInstructions(worker), now, 'worker'),
  );

  for (let i = 0; i < primaryWorkerSpecs.length; i++) {
    const workerSpec = primaryWorkerSpecs[i];
    const workerGroup = workerGroups[i];

    if (ensureDestination(primaryFrontdeskGroup, workerGroup, workerSpec.localName, now)) {
      touchedGroups.add(primaryFrontdeskGroup.id);
      console.log(`Linked agent destination: ${primaryFrontdeskGroup.name} -> ${workerSpec.localName}`);
    }
    if (ensureDestination(workerGroup, primaryFrontdeskGroup, FRONTDESK_DESTINATION_NAME, now)) {
      touchedGroups.add(workerGroup.id);
      console.log(`Linked agent destination: ${workerGroup.name} -> ${FRONTDESK_DESTINATION_NAME}`);
    }
  }

  // 3. Shared-entry channel wiring (only the primary desk; ADR-0008 §3).
  const sharedEntry = ensureSharedEntryWiring(primaryFrontdeskGroup, args, now);
  if (sharedEntry) touchedGroups.add(primaryFrontdeskGroup.id);

  for (const agentGroupId of touchedGroups) {
    refreshDestinations(agentGroupId);
  }

  console.log('');
  console.log('Enterprise topology ready.');
  for (const [idx, group] of frontdeskGroups.entries()) {
    const tag = idx === 0 ? 'frontdesk (primary)' : 'frontdesk (secondary)';
    console.log(`  ${tag}: ${group.name} [${group.id}] @ groups/${group.folder}`);
  }
  for (const worker of workerGroups) {
    console.log(`  worker:    ${worker.name} [${worker.id}] @ groups/${worker.folder}`);
  }
  if (sharedEntry) {
    console.log(`  channel:   ${sharedEntry.channel_type} ${sharedEntry.platform_id}`);
  }
  console.log('');
  console.log(
    'Next step: run `pnpm exec tsx scripts/configure-enterprise-gateway.ts --base-url <gateway>` and point these groups at your auth/ERP capability layer.',
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

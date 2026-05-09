/**
 * Bootstrap a shared-enterprise FrontLane topology.
 *
 * Creates/reuses a frontdesk agent group plus a set of specialist workers,
 * seeds their group files with enterprise-oriented starter instructions,
 * wires bidirectional agent destinations, and optionally wires a shared
 * entry channel to the frontdesk.
 *
 * Usage:
 *   pnpm exec tsx scripts/init-enterprise-topology.ts
 *
 *   pnpm exec tsx scripts/init-enterprise-topology.ts \
 *     --channel feishu \
 *     --platform-id oc_xxx \
 *     --group-name "FrontLane Desk" \
 *     --threaded
 *
 * Optional args:
 *   --frontdesk-name "FrontLane Desk"
 *   --frontdesk-folder frontlane-frontdesk
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

interface Args {
  frontdeskName: string;
  frontdeskFolder: string;
  workers: string[];
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
  let frontdeskName: string | undefined;
  let frontdeskFolder: string | undefined;
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

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--frontdesk-name':
        frontdeskName = val;
        i++;
        break;
      case '--frontdesk-folder':
        frontdeskFolder = val;
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

  const workers = parseWorkers(workersRaw);

  return {
    frontdeskName: frontdeskName?.trim() || DEFAULT_FRONTDESK_NAME,
    frontdeskFolder: normalizeName(frontdeskFolder?.trim() || DEFAULT_FRONTDESK_FOLDER),
    workers,
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

Working rules:
- if the request involves identity, entitlements, or permission ambiguity, route to \`access-worker\` first when available
- for money movement, approvals, status changes, or destructive operations, require explicit confirmation and use the approval path
- use <message to="worker-name">...</message> for delegation and include only the minimum context needed
- return concise user-facing summaries after worker results come back
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

function ensureAgentGroup(folder: string, name: string, instructions: string, now: string): AgentGroup {
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
      name: args.groupName || args.frontdeskName,
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
  const workerSpecs = buildWorkerSpecs(args.workers);
  const touchedGroups = new Set<string>();

  if (workerSpecs.some((worker) => worker.folder === args.frontdeskFolder)) {
    throw new Error(
      `Frontdesk folder "${args.frontdeskFolder}" collides with a worker folder. Pick a different --frontdesk-folder or worker name.`,
    );
  }

  const frontdesk = ensureAgentGroup(
    args.frontdeskFolder,
    args.frontdeskName,
    buildFrontdeskInstructions(args.frontdeskName, workerSpecs),
    now,
  );

  const workers = workerSpecs.map((worker) =>
    ensureAgentGroup(worker.folder, worker.displayName, buildWorkerInstructions(worker), now),
  );

  for (let i = 0; i < workerSpecs.length; i++) {
    const workerSpec = workerSpecs[i];
    const workerGroup = workers[i];

    if (ensureDestination(frontdesk, workerGroup, workerSpec.localName, now)) {
      touchedGroups.add(frontdesk.id);
      console.log(`Linked agent destination: ${frontdesk.name} -> ${workerSpec.localName}`);
    }
    if (ensureDestination(workerGroup, frontdesk, FRONTDESK_DESTINATION_NAME, now)) {
      touchedGroups.add(workerGroup.id);
      console.log(`Linked agent destination: ${workerGroup.name} -> ${FRONTDESK_DESTINATION_NAME}`);
    }
  }

  const sharedEntry = ensureSharedEntryWiring(frontdesk, args, now);
  if (sharedEntry) touchedGroups.add(frontdesk.id);

  for (const agentGroupId of touchedGroups) {
    refreshDestinations(agentGroupId);
  }

  console.log('');
  console.log('Enterprise topology ready.');
  console.log(`  frontdesk: ${frontdesk.name} [${frontdesk.id}] @ groups/${frontdesk.folder}`);
  for (const worker of workers) {
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

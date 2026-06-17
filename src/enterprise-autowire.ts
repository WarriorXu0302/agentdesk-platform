import fs from 'fs';
import path from 'path';

import { resolveFrontdeskFolderFromGroups } from './branding.js';
import type { InboundEvent } from './channels/adapter.js';
import { GROUPS_DIR } from './config.js';
import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { recordEnterpriseAudit } from './db/enterprise-audit.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  updateMessagingGroup,
} from './db/messaging-groups.js';
import { readEnvFile } from './env.js';
import { initGroupFilesystem } from './group-init.js';
import { log } from './log.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from './types.js';

const ENTERPRISE_ENV_KEYS = [
  'ENTERPRISE_FRONTDESK_FOLDER',
  'ENTERPRISE_AUTO_WIRE_CHANNELS',
  'ENTERPRISE_AUTO_WIRE_P2P',
  'ENTERPRISE_AUTO_WIRE_GROUPS',
  'ENTERPRISE_AUTO_WIRE_GROUP_SESSION_MODE',
  'ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY',
  'ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED',
  'ENTERPRISE_AUTO_WIRE_ALLOW_POLICY_DOWNGRADE',
] as const;

interface EnterpriseAutowireConfig {
  frontdeskFolder: string;
  autoWireChannels: Set<string>;
  autoWireP2p: boolean;
  autoWireGroups: boolean;
  groupSessionMode: Extract<
    MessagingGroupAgent['session_mode'],
    'shared' | 'per-thread' | 'per-user' | 'per-user-per-thread'
  >;
  // Which PLUGGABLE group→agent strategy to use for a new GROUP (ADR-0053):
  // 'shared' (all groups share the frontdesk) | 'per-group' (each group gets its
  // own cloned agent) | any operator-registered custom strategy name. DMs (p2p)
  // always use the shared frontdesk regardless.
  groupStrategy: string;
  allowPolicyDowngrade: boolean;
}

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function envValue(dotenv: Record<string, string>, key: (typeof ENTERPRISE_ENV_KEYS)[number]): string | undefined {
  return process.env[key] ?? dotenv[key];
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseChannelSet(value: string | undefined): Set<string> {
  const channels = (value || 'feishu')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return new Set(channels);
}

function parseGroupSessionMode(value: string | undefined): EnterpriseAutowireConfig['groupSessionMode'] {
  switch (value?.trim()) {
    case 'shared':
      return 'shared';
    case 'per-thread':
      return 'per-thread';
    case 'per-user':
      return 'per-user';
    case 'per-user-per-thread':
      return 'per-user-per-thread';
    default:
      return 'per-user';
  }
}

function readConfig(): EnterpriseAutowireConfig {
  const dotenv = readEnvFile([...ENTERPRISE_ENV_KEYS]);
  return {
    frontdeskFolder: resolveFrontdeskFolderFromGroups(GROUPS_DIR, envValue(dotenv, 'ENTERPRISE_FRONTDESK_FOLDER')),
    autoWireChannels: parseChannelSet(envValue(dotenv, 'ENTERPRISE_AUTO_WIRE_CHANNELS')),
    autoWireP2p: parseBoolean(envValue(dotenv, 'ENTERPRISE_AUTO_WIRE_P2P'), false),
    autoWireGroups: parseBoolean(envValue(dotenv, 'ENTERPRISE_AUTO_WIRE_GROUPS'), false),
    groupSessionMode: parseGroupSessionMode(envValue(dotenv, 'ENTERPRISE_AUTO_WIRE_GROUP_SESSION_MODE')),
    // Explicit strategy name wins; else the legacy boolean `*_GROUP_ISOLATED=true`
    // is honored as an alias for 'per-group'; else 'shared'.
    groupStrategy:
      envValue(dotenv, 'ENTERPRISE_AUTO_WIRE_GROUP_STRATEGY')?.trim() ||
      (parseBoolean(envValue(dotenv, 'ENTERPRISE_AUTO_WIRE_GROUP_ISOLATED'), false) ? 'per-group' : 'shared'),
    // Default true to preserve legacy behavior for existing deployments.
    // Operators who want strict-by-default can set this to false; autowire
    // will then refuse to flip unknown_sender_policy and will skip wiring
    // instead, leaving the existing channel-request-approval flow to handle
    // unknown senders explicitly.
    allowPolicyDowngrade: parseBoolean(envValue(dotenv, 'ENTERPRISE_AUTO_WIRE_ALLOW_POLICY_DOWNGRADE'), true),
  };
}

function shouldAutowire(config: EnterpriseAutowireConfig, event: InboundEvent): boolean {
  if (!config.frontdeskFolder) return false;
  if (!config.autoWireChannels.has(event.channelType.toLowerCase())) return false;
  if (event.message.isGroup) return config.autoWireGroups && event.message.isMention === true;
  return config.autoWireP2p;
}

function buildAutoWiring(
  config: EnterpriseAutowireConfig,
  messagingGroupId: string,
  agentGroupId: string,
  isGroup: boolean,
): MessagingGroupAgent {
  return {
    id: generateId('mga'),
    messaging_group_id: messagingGroupId,
    agent_group_id: agentGroupId,
    engage_mode: isGroup ? 'mention-sticky' : 'pattern',
    engage_pattern: isGroup ? null : '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: isGroup ? config.groupSessionMode : 'shared',
    priority: 100,
    created_at: new Date().toISOString(),
  };
}

function slugifyPlatformId(platformId: string): string {
  return (
    platformId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'group'
  );
}

/**
 * ISOLATED mode (ADR-0053): resolve — or, on first contact, create — the
 * per-group agent for this messaging group. It's a clone of the frontdesk that
 * gets its OWN workspace + memory (CLAUDE.local.md / conversations/) so groups
 * don't share recall. Only `container.json` is cloned: CLAUDE.md is composed
 * fresh per spawn and skills symlink at spawn from container.json, so nothing
 * else needs copying. Idempotent — keyed on a deterministic folder derived from
 * the messaging group's platform_id; a concurrent first-message that loses the
 * create re-fetches the winner. Inherits the frontdesk's organization (ADR-0052).
 */
function resolveOrCreatePerGroupAgent(frontdesk: AgentGroup, mg: MessagingGroup): AgentGroup {
  const folder = `${frontdesk.folder}-g-${slugifyPlatformId(mg.platform_id)}`;
  const existing = getAgentGroupByFolder(folder);
  if (existing) return existing;

  const group: AgentGroup = {
    id: `ag-${folder}`,
    name: mg.name?.trim() || `Group ${mg.platform_id}`,
    folder,
    agent_provider: frontdesk.agent_provider,
    created_at: new Date().toISOString(),
    organization_id: frontdesk.organization_id ?? null,
  };
  try {
    createAgentGroup(group);
  } catch (err) {
    // Concurrent first-message race: another inbound created the same folder/id.
    const raced = getAgentGroupByFolder(folder);
    if (raced) return raced;
    throw err;
  }
  initGroupFilesystem(group);
  // Clone the frontdesk's container.json (skills / MCP / gateway / resources) so
  // the isolated agent behaves like the frontdesk; memory stays fresh + per-group.
  try {
    const src = path.join(GROUPS_DIR, frontdesk.folder, 'container.json');
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(GROUPS_DIR, folder, 'container.json'));
    }
  } catch (err) {
    log.warn('Per-group agent: container.json clone failed — using defaults', { folder, err });
  }
  recordEnterpriseAudit({
    eventType: 'autowire_group_agent_provisioned',
    messagingGroupId: mg.id,
    agentGroupId: group.id,
    details: { folder, clonedFrom: frontdesk.folder, organizationId: group.organization_id },
  });
  log.info('Per-group isolated agent provisioned (ADR-0053)', {
    folder,
    id: group.id,
    clonedFrom: frontdesk.folder,
    messagingGroupId: mg.id,
  });
  return group;
}

/**
 * Pluggable group→agent strategy (ADR-0053). Given the frontdesk + a NEW group's
 * messaging group, return the agent group the channel should wire to. Built-ins:
 * `shared` (all groups share the frontdesk) and `per-group` (each group gets its
 * own clone). Operators add custom strategies (by-department, by-attribute, …)
 * with `registerGroupAgentStrategy` from a module loaded at startup — no core
 * edit. Strategies apply to GROUPS only; DMs (p2p) always use the shared frontdesk.
 * Keep it synchronous: the routing hot path is sync (router.ts).
 */
export type GroupAgentStrategy = (input: {
  frontdesk: AgentGroup;
  mg: MessagingGroup;
  event: InboundEvent;
}) => AgentGroup;

const groupAgentStrategies = new Map<string, GroupAgentStrategy>();

export function registerGroupAgentStrategy(name: string, strategy: GroupAgentStrategy): void {
  groupAgentStrategies.set(name, strategy);
}

export function listGroupAgentStrategies(): string[] {
  return [...groupAgentStrategies.keys()].sort();
}

// Built-in strategies.
registerGroupAgentStrategy('shared', ({ frontdesk }) => frontdesk);
registerGroupAgentStrategy('per-group', ({ frontdesk, mg }) => resolveOrCreatePerGroupAgent(frontdesk, mg));

export function maybeAutowireEnterpriseFrontdesk(mg: MessagingGroup, event: InboundEvent): boolean {
  const config = readConfig();
  if (!shouldAutowire(config, event)) return false;

  if (event.message.isGroup && mg.denied_at) {
    log.info('Enterprise autowire skipped for denied group channel', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return false;
  }

  const frontdesk = getAgentGroupByFolder(config.frontdeskFolder);
  if (!frontdesk) {
    log.warn('Enterprise autowire skipped: frontdesk agent group not found', {
      folder: config.frontdeskFolder,
      channelType: event.channelType,
      platformId: event.platformId,
    });
    return false;
  }

  const isGroup = event.message.isGroup === true;
  const previousPolicy = mg.unknown_sender_policy;

  // Decide the policy gate BEFORE provisioning a per-group agent, so a refused
  // wiring never leaves an orphan agent group behind.
  if (previousPolicy !== 'public' && !config.allowPolicyDowngrade) {
    log.warn('Enterprise autowire skipped: policy downgrade disabled and sender policy is not public', {
      messagingGroupId: mg.id,
      channelType: event.channelType,
      platformId: event.platformId,
      unknownSenderPolicy: previousPolicy,
    });
    recordEnterpriseAudit({
      eventType: 'autowire_policy_downgrade_skipped',
      messagingGroupId: mg.id,
      agentGroupId: frontdesk.id,
      details: { channelType: event.channelType, platformId: event.platformId, previousPolicy },
    });
    return false;
  }

  // Resolve the target agent via the pluggable group→agent strategy (ADR-0053).
  // DMs (p2p) always use the shared frontdesk. An unknown strategy name fails
  // SAFE to 'shared' (never drops the message) + warns. Resolve-or-create
  // strategies (e.g. 'per-group') are idempotent, so an already-existing
  // per-group agent is reused (no orphan on the already-wired path below).
  let strategyName = 'shared';
  let target = frontdesk;
  if (isGroup) {
    strategyName = config.groupStrategy;
    let strategy = groupAgentStrategies.get(strategyName);
    if (!strategy) {
      log.warn('Enterprise autowire: unknown group strategy — falling back to shared', {
        strategy: strategyName,
        known: listGroupAgentStrategies(),
      });
      strategyName = 'shared';
      strategy = groupAgentStrategies.get('shared')!;
    }
    target = strategy({ frontdesk, mg, event });
  }

  if (getMessagingGroupAgentByPair(mg.id, target.id)) {
    return true;
  }

  if (previousPolicy !== 'public') {
    updateMessagingGroup(mg.id, { unknown_sender_policy: 'public' });
    mg.unknown_sender_policy = 'public';
    recordEnterpriseAudit({
      eventType: 'autowire_policy_downgrade',
      messagingGroupId: mg.id,
      agentGroupId: target.id,
      details: {
        channelType: event.channelType,
        platformId: event.platformId,
        previousPolicy,
        newPolicy: 'public',
      },
    });
  }

  const wiring = buildAutoWiring(config, mg.id, target.id, isGroup);
  createMessagingGroupAgent(wiring);
  recordEnterpriseAudit({
    eventType: 'autowire_frontdesk',
    messagingGroupId: mg.id,
    agentGroupId: target.id,
    details: {
      channelType: event.channelType,
      platformId: event.platformId,
      isGroup,
      strategy: strategyName,
      sessionMode: wiring.session_mode,
      engageMode: wiring.engage_mode,
    },
  });
  log.info('Enterprise frontdesk auto-wired', {
    messagingGroupId: mg.id,
    agentGroupId: target.id,
    folder: target.folder,
    strategy: strategyName,
    channelType: event.channelType,
    platformId: event.platformId,
    isGroup,
    sessionMode: wiring.session_mode,
    engageMode: wiring.engage_mode,
  });
  return true;
}

import { resolveFrontdeskFolderFromGroups } from './branding.js';
import type { InboundEvent } from './channels/adapter.js';
import { GROUPS_DIR } from './config.js';
import { getAgentGroupByFolder } from './db/agent-groups.js';
import { recordEnterpriseAudit } from './db/enterprise-audit.js';
import {
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  updateMessagingGroup,
} from './db/messaging-groups.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import type { MessagingGroup, MessagingGroupAgent } from './types.js';

const ENTERPRISE_ENV_KEYS = [
  'ENTERPRISE_FRONTDESK_FOLDER',
  'ENTERPRISE_AUTO_WIRE_CHANNELS',
  'ENTERPRISE_AUTO_WIRE_P2P',
  'ENTERPRISE_AUTO_WIRE_GROUPS',
  'ENTERPRISE_AUTO_WIRE_GROUP_SESSION_MODE',
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

  if (getMessagingGroupAgentByPair(mg.id, frontdesk.id)) {
    return true;
  }

  const previousPolicy = mg.unknown_sender_policy;
  if (previousPolicy !== 'public') {
    if (!config.allowPolicyDowngrade) {
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
        details: {
          channelType: event.channelType,
          platformId: event.platformId,
          previousPolicy,
        },
      });
      return false;
    }
    updateMessagingGroup(mg.id, { unknown_sender_policy: 'public' });
    mg.unknown_sender_policy = 'public';
    recordEnterpriseAudit({
      eventType: 'autowire_policy_downgrade',
      messagingGroupId: mg.id,
      agentGroupId: frontdesk.id,
      details: {
        channelType: event.channelType,
        platformId: event.platformId,
        previousPolicy,
        newPolicy: 'public',
      },
    });
  }

  const wiring = buildAutoWiring(config, mg.id, frontdesk.id, event.message.isGroup === true);
  createMessagingGroupAgent(wiring);
  recordEnterpriseAudit({
    eventType: 'autowire_frontdesk',
    messagingGroupId: mg.id,
    agentGroupId: frontdesk.id,
    details: {
      channelType: event.channelType,
      platformId: event.platformId,
      isGroup: event.message.isGroup === true,
      sessionMode: wiring.session_mode,
      engageMode: wiring.engage_mode,
    },
  });
  log.info('Enterprise frontdesk auto-wired', {
    messagingGroupId: mg.id,
    agentGroupId: frontdesk.id,
    folder: config.frontdeskFolder,
    channelType: event.channelType,
    platformId: event.platformId,
    isGroup: event.message.isGroup === true,
    sessionMode: wiring.session_mode,
    engageMode: wiring.engage_mode,
  });
  return true;
}

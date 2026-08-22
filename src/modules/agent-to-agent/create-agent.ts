/**
 * `create_agent` delivery-action handler.
 *
 * Spawns a new agent group on demand from the parent agent, wires bidirectional
 * agent_destinations rows, projects the new destination into the parent's
 * running container, and notifies the parent.
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { readString } from '../../outbound-contract.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

/**
 * Display names that cannot forge an operator-facing surface: no control or
 * format characters (bidi overrides make displayed text differ from stored
 * text), no line/paragraph separators, no backtick (closes a markdown fence),
 * no backslash (the Feishu card renderer expands the two-character sequence
 * backslash-n into a real newline AFTER validation). Non-Latin scripts are
 * unaffected — the rule is about Unicode classes, not ASCII.
 */
const DISPLAY_NAME_RE = /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}`\\]{1,64}$/u;

/** Cap on the role prompt an agent may write for the agent it spawns. */
const MAX_INSTRUCTIONS_LEN = 64 * 1024;

function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export async function handleCreateAgent(content: Record<string, unknown>, session: Session): Promise<void> {
  const nameR = readString(content, 'name', { required: true, maxLength: 64, pattern: DISPLAY_NAME_RE });
  // `instructions` is written straight to groups/<folder>/instructions.md and
  // becomes the new agent's role prompt, so it is a file the container gets to
  // author. Bounded and type-checked rather than cast (ADR-0063).
  const instructionsR = readString(content, 'instructions', { maxLength: MAX_INSTRUCTIONS_LEN });

  const sourceGroup = getAgentGroup(session.agent_group_id);
  if (!sourceGroup) {
    notifyAgent(session, `create_agent failed: source agent group not found.`);
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id });
    return;
  }

  // The DISPLAY name is persisted verbatim (only `folder` below is normalized),
  // and it is later interpolated into operator-facing surfaces — including the
  // self-mod approval card, where a name carrying newlines or a fence-closing
  // backtick can forge the prose an admin reads next to Approve. This action is
  // container-callable, so the name is untrusted input like any other field on
  // a messages_out row (ADR-0063).
  if (!nameR.ok) {
    notifyAgent(
      session,
      'create_agent failed: name must be 1-64 characters with no line breaks, backticks, backslashes, or invisible formatting characters.',
    );
    log.warn('create_agent rejected an unsafe display name', {
      sessionAgentGroup: session.agent_group_id,
      reason: nameR.reason,
    });
    return;
  }
  if (!instructionsR.ok) {
    notifyAgent(session, `create_agent failed: ${instructionsR.reason}.`);
    log.warn('create_agent rejected unsafe instructions', {
      sessionAgentGroup: session.agent_group_id,
      reason: instructionsR.reason,
    });
    return;
  }
  const name = nameR.value;
  const instructions = instructionsR.value || null;

  const localName = normalizeName(name);

  // Collision in the creator's destination namespace
  if (getDestinationByName(sourceGroup.id, localName)) {
    notifyAgent(session, `Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Derive a safe folder name, deduplicated globally across agent_groups.folder
  let folder = localName;
  let suffix = 2;
  while (getAgentGroupByFolder(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    notifyAgent(session, `Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: now,
    // FIX-3 (ADR-0052): a spawned worker INHERITS its creator's organization, so
    // it lands inside the same tenant boundary instead of becoming a NULL-org
    // (cross-org-reachable) island. The bidirectional destination rows below are
    // therefore same-org by construction; createDestination still asserts it.
    organization_id: sourceGroup.organization_id,
    // An a2a-spawned agent is by definition a delegated specialist (ADR-0056).
    role: 'worker',
  };
  createAgentGroup(newGroup);
  initGroupFilesystem(newGroup, { instructions: instructions ?? undefined });

  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  createDestination({
    agent_group_id: sourceGroup.id,
    local_name: localName,
    target_type: 'agent',
    target_id: agentGroupId,
    created_at: now,
  });
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (getDestinationByName(agentGroupId, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  createDestination({
    agent_group_id: agentGroupId,
    local_name: parentName,
    target_type: 'agent',
    target_id: sourceGroup.id,
    created_at: now,
  });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  writeDestinations(session.agent_group_id, session.id);

  // Fire-and-forget notification back to the creator
  notifyAgent(
    session,
    `Agent "${localName}" created. You can now message it with <message to="${localName}">...</message>.`,
  );
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
}

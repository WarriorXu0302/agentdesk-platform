/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - a shared base (`container/CLAUDE.md` mounted RO at `/app/CLAUDE.md`)
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - per-group agent memory (`CLAUDE.local.md`, auto-loaded by Claude Code)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { readContainerConfig } from './container-config.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Symlink targets are container paths — dangling on host (hence the readlink
// dance instead of existsSync), valid inside the container via RO mounts.
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
const SHARED_MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';

// Host-side source paths used to discover fragment sources at compose time.
// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

interface SkillFrontmatter {
  name?: string;
  description?: string;
}

// Lightweight YAML frontmatter reader for SKILL.md — only handles single-line
// scalar fields (name, description). Multi-line / nested YAML would need a
// full parser, but skills today don't use those for the fields we need.
function readSkillFrontmatter(skillMdPath: string): SkillFrontmatter {
  if (!fs.existsSync(skillMdPath)) return {};
  try {
    const text = fs.readFileSync(skillMdPath, 'utf8');
    const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
    if (!match) return {};
    const out: SkillFrontmatter = {};
    for (const line of match[1].split('\n')) {
      const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1].trim();
      let value = kv[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === 'name') out.name = value;
      else if (key === 'description') out.description = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, enabled skill
 * fragments, and MCP server fragments declared in `container.json`. Creates
 * an empty `CLAUDE.local.md` if missing.
 */
export function composeGroupClaudeMd(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  // Desired fragment set.
  const config = readContainerConfig(group.folder);
  const desired = new Map<string, { type: 'symlink' | 'inline'; content: string }>();

  // Skill fragments — only skills that ship an `instructions.md`. If
  // `container.json#skills` is `"all"` (default), every available skill is
  // inlined. If it's an array, only those skills are inlined — silently
  // skips array entries that don't exist on disk or lack `instructions.md`.
  //
  // PROGRESSIVE DISCLOSURE: when config.progressiveDisclosure=true, the
  // per-skill instructions.md is NOT inlined. Instead, a single
  // `skill-index.md` is generated listing each available skill's name +
  // description (parsed from SKILL.md frontmatter). The agent then calls
  // the `load_skill(name)` MCP tool to fetch a specific skill's full
  // instructions on demand. Keeps the system prompt small + cache-stable;
  // skill content lands in transcript only when needed.
  const skillsHostDir = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsHostDir)) {
    const candidates = config.skills === 'all' ? fs.readdirSync(skillsHostDir) : config.skills;

    if (config.progressiveDisclosure === 'lean') {
      // Lean mode — no skill index at all. Dispatcher agents that route
      // to workers via <message to="..."> blocks don't need the index;
      // worker capabilities live in their own CLAUDE.md / fragments,
      // not in the dispatcher's prompt.
      //
      // The `load_skill` MCP tool is still registered container-side but
      // the agent has no list to call it against, which is the intent.
    } else if (config.progressiveDisclosure) {
      // Index mode — replace full instructions with a one-line-per-skill
      // index + an anti-overthink preamble. Helps gpt-5.4 avoid wasting
      // scratchpad cycles on "should I load a skill?" for trivial
      // greetings / acknowledgements / fixed-template replies.
      const indexLines: string[] = [
        '# Available Skills',
        '',
        "These skills are available but NOT loaded into your prompt. To use a skill, call the `load_skill(name)` MCP tool FIRST — its `instructions.md` will be returned as a tool result and become part of the conversation history. After loading, follow the skill's instructions to complete the task.",
        '',
        '## Decision shortcut (DO NOT skip)',
        '',
        '- If the incoming message is a simple greeting / acknowledgement / yes-no confirmation / "你好"/"在吗"/"OK"/"收到"/casual chitchat → respond DIRECTLY with the appropriate fixed-template reply. **Do NOT call `load_skill`. Do NOT enumerate this list.**',
        '- If the message clearly maps to one specific worker (knowledge/robot/labops/monitor/remote/feishu/...) you can dispatch to → use `<message to="<worker-name>">...</message>` and DO NOT load a skill. Skills are for workers to use, not for the dispatcher.',
        '- Only call `load_skill(name)` when YOU (the dispatcher) genuinely need a specific how-to for an unusual operation that no worker handles. This is rare.',
        '',
        '## Skill index',
        '',
      ];
      for (const skillName of candidates) {
        const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
        if (!fs.existsSync(hostFragment)) continue;
        const meta = readSkillFrontmatter(path.join(skillsHostDir, skillName, 'SKILL.md'));
        const name = meta.name ?? skillName;
        const desc = (meta.description ?? '').trim() || '(no description)';
        indexLines.push(`- **${name}** — ${desc}`);
      }
      indexLines.push('');
      desired.set('skill-index.md', {
        type: 'inline',
        content: indexLines.join('\n'),
      });
    } else {
      for (const skillName of candidates) {
        const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
        if (fs.existsSync(hostFragment)) {
          desired.set(`skill-${skillName}.md`, {
            type: 'symlink',
            content: `${SHARED_SKILLS_CONTAINER_BASE}/${skillName}/instructions.md`,
          });
        }
      }
    }
  }

  // Built-in module fragments — every MCP tool source file that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's MCP tools (schedule_task, install_packages, etc.).
  // Always included — these are built-in, not toggleable.
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      desired.set(`module-${moduleName}.md`, {
        type: 'symlink',
        content: `${SHARED_MCP_TOOLS_CONTAINER_BASE}/${entry}`,
      });
    }
  }

  // MCP server fragments — inline instructions from container.json for
  // user-added external MCP servers.
  for (const [name, mcp] of Object.entries(config.mcpServers)) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, {
        type: 'inline',
        content: mcp.instructions,
      });
    }
  }

  // Reconcile: drop stale, write desired.
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, frag] of desired) {
    const fragPath = path.join(fragmentsDir, name);
    if (frag.type === 'symlink') {
      syncSymlink(fragPath, frag.content);
    } else {
      writeAtomic(fragPath, frag.content);
    }
  }

  // Composed entry — imports only.
  const imports = ['@./.claude-shared.md'];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}

/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content already in `container/CLAUDE.md`)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.readlinkSync(linkPath);
  } catch {
    /* missing */
  }
  if (currentTarget === target) return;
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* missing */
  }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

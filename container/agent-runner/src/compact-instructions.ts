/**
 * Shared compaction-instruction text.
 *
 * Two consumers depend on the *same* routing-preservation rules so the
 * summaries they produce don't drift apart:
 *
 *  1. The Claude PreCompact hook — Claude Code captures the stdout of
 *     PreCompact shell hooks and passes it as `customInstructions` to its
 *     auto-compaction prompt. Invoked from .claude-shared/settings.json:
 *       "command": "bun /app/src/compact-instructions.ts"
 *
 *  2. The OpenAI provider's summarize-old-window step — it feeds the same
 *     text as the system prompt when it asks a cheap model to compress the
 *     stale part of a long conversation (see providers/openai.ts).
 *
 * Keeping the text in one pure function (`buildCompactionInstructions`)
 * means both paths emit the same `<message to="…">` discipline and the same
 * destination roster. The CLI entrypoint at the bottom only runs when this
 * module is executed directly (by the PreCompact hook), so importing the
 * function from another module has no side effects.
 */
import { getAllDestinations, type DestinationEntry } from './destinations.js';

/**
 * Build the compaction-summary instruction block. Pure — takes the live
 * destination roster and returns the instruction text. Shared by the Claude
 * PreCompact hook and the OpenAI provider's summarization step.
 */
export function buildCompactionInstructions(destinations: DestinationEntry[]): string {
  const names = destinations.map((d) => d.name);
  return [
    'Preserve the following in the compaction summary:',
    '',
    '1. For recent messages, keep the full XML structure including all attributes:',
    '   - <message from="..." sender="..." time="..."> for chat messages',
    '   - <task from="..." time="..."> for scheduled tasks',
    '   - <webhook from="..." source="..." event="..."> for webhooks',
    '   The message content can be summarized if long, but the XML tags and attributes must remain.',
    '',
    '2. Preserve the chronological message/reply sequence of recent exchanges.',
    '   The agent needs to see: who said what, in what order, and from which destination.',
    '',
    '3. The `from` attribute identifies which destination sent the message.',
    '   The agent MUST wrap all responses in <message to="name">...</message> blocks.',
    `   Available destinations: ${names.length > 0 ? names.map((n) => `\`${n}\``).join(', ') : '(none)'}`,
  ].join('\n');
}

// CLI entrypoint: only runs when this module is the program's entry (i.e.
// invoked by the Claude PreCompact hook), not when imported for the function.
if (import.meta.main) {
  console.log(buildCompactionInstructions(getAllDestinations()));
}

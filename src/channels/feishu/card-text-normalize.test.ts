/**
 * Feishu card text normalization (the `\n`-shows-up-literally fix).
 *
 * Models occasionally emit the two-character escape `\n` (backslash + n) or CRLF
 * instead of a real newline. Feishu's `markdown` element renders a real LF as a
 * line break but shows `\n` verbatim, so card bodies sometimes displayed a stray
 * "\n" to users. normalizeCardText folds both forms to a real LF, and every card
 * builder that puts agent/host text into a `markdown` element runs it through.
 */
import { describe, it, expect } from 'vitest';

import {
  normalizeCardText,
  buildMarkdownCard,
  buildDisplayCard,
  buildFeishuAskQuestionCardWithPayloads,
} from './primitives.js';

/** Pull the first markdown element's content out of a built card. */
function markdownContent(card: Record<string, unknown>): string {
  const body = card.body as { elements: Array<{ tag: string; content?: string }> };
  const md = body.elements.find((e) => e.tag === 'markdown');
  return md?.content ?? '';
}

describe('normalizeCardText', () => {
  it('folds a literal backslash-n escape into a real newline', () => {
    expect(normalizeCardText('line one\\nline two')).toBe('line one\nline two');
  });

  it('folds a literal backslash-r-backslash-n escape into a single newline', () => {
    expect(normalizeCardText('line one\\r\\nline two')).toBe('line one\nline two');
  });

  it('folds real CRLF and bare CR into LF', () => {
    expect(normalizeCardText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('leaves a real newline untouched', () => {
    expect(normalizeCardText('a\nb')).toBe('a\nb');
  });

  it('handles many escapes in one string', () => {
    expect(normalizeCardText('a\\nb\\nc')).toBe('a\nb\nc');
  });

  it('is a no-op for text with no newlines of any kind', () => {
    expect(normalizeCardText('just some text')).toBe('just some text');
  });

  it('never leaves a literal backslash-n behind', () => {
    expect(normalizeCardText('x\\ny')).not.toContain('\\n');
  });
});

describe('card builders normalize markdown content', () => {
  it('buildMarkdownCard normalizes a literal \\n in the body', () => {
    const content = markdownContent(buildMarkdownCard('top\\nbottom'));
    expect(content).toBe('top\nbottom');
    expect(content).not.toContain('\\n');
  });

  it('buildDisplayCard (which routes through buildMarkdownCard) normalizes', () => {
    // buildDisplayCard joins child sections; a child carrying a literal escape
    // must still render as a line break.
    const content = markdownContent(buildDisplayCard({ card: { children: [{ text: 'alpha\\nbeta' }] } }));
    expect(content).not.toContain('\\n');
    expect(content).toContain('alpha\nbeta');
  });

  it('buildFeishuAskQuestionCardWithPayloads normalizes the question', () => {
    const card = buildFeishuAskQuestionCardWithPayloads({
      title: 'Pick one',
      questionId: 'q1',
      question: 'first?\\nsecond?',
      options: [{ label: 'Yes', value: 'yes', selectedLabel: 'Yes' }],
    });
    const content = markdownContent(card);
    expect(content).toBe('first?\nsecond?');
    expect(content).not.toContain('\\n');
  });
});

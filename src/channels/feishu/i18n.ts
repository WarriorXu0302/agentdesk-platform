/**
 * Minimal i18n for platform-emitted Feishu system strings (roadmap 6.5).
 *
 * Feishu's primary market is Chinese-language orgs, but the platform's own
 * card titles / notices were hardcoded English ("Question", "This request has
 * expired…"), so a zh user got a jarring mixed-language experience even when the
 * agent replied in Chinese. This localizes ONLY those platform-emitted strings —
 * agent message content is the agent's own concern and is untouched.
 *
 * Scope is deliberately small + low-risk: a static catalog + a host-wide locale
 * from `FEISHU_SYSTEM_LOCALE` (default `en`). Per-user locale detection from the
 * event (`user.locale`) is a future enhancement; this is the deterministic
 * minimum. These are display strings only — never identity/routing/audit values.
 */
export type FeishuLocale = 'en' | 'zh';

/** Keys for every platform-emitted user-facing Feishu string. */
type CatalogKey = 'card.question.title' | 'card.expired' | 'card.replyHint';

const CATALOG: Record<CatalogKey, Record<FeishuLocale, string>> = {
  'card.question.title': { en: 'Question', zh: '请选择' },
  'card.expired': {
    en: 'This request has expired and can no longer be actioned. Please ask the assistant to send it again.',
    zh: '该请求已过期，无法再操作。请让助手重新发送。',
  },
  'card.replyHint': {
    en: 'Reply with the option number or its text.',
    zh: '请回复选项编号或对应文字。',
  },
};

/**
 * Host-wide system locale from `FEISHU_SYSTEM_LOCALE`. Anything other than a
 * supported locale falls back to `en` (so a typo never breaks a card — it just
 * shows English). Read per-call (cheap) so a process env change is picked up.
 */
export function feishuLocale(): FeishuLocale {
  const raw = (process.env.FEISHU_SYSTEM_LOCALE ?? '').trim().toLowerCase();
  return raw === 'zh' || raw.startsWith('zh-') ? 'zh' : 'en';
}

/** Localize a platform-emitted string. Falls back to English for any miss. */
export function t(key: CatalogKey, locale: FeishuLocale = feishuLocale()): string {
  const entry = CATALOG[key];
  return entry[locale] ?? entry.en;
}

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { feishuLocale, t } from './i18n.js';

describe('feishu i18n (roadmap 6.5)', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.FEISHU_SYSTEM_LOCALE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.FEISHU_SYSTEM_LOCALE;
    else process.env.FEISHU_SYSTEM_LOCALE = saved;
  });

  it('defaults to en when FEISHU_SYSTEM_LOCALE is unset', () => {
    delete process.env.FEISHU_SYSTEM_LOCALE;
    expect(feishuLocale()).toBe('en');
    expect(t('card.question.title')).toBe('Question');
    expect(t('card.replyHint')).toContain('Reply with the option');
  });

  it('returns zh strings when FEISHU_SYSTEM_LOCALE=zh (incl. zh-CN)', () => {
    process.env.FEISHU_SYSTEM_LOCALE = 'zh';
    expect(feishuLocale()).toBe('zh');
    expect(t('card.question.title')).toBe('请选择');
    expect(t('card.expired')).toContain('已过期');

    process.env.FEISHU_SYSTEM_LOCALE = 'zh-CN';
    expect(feishuLocale()).toBe('zh');
  });

  it('falls back to en for an unsupported locale (typo never breaks a card)', () => {
    process.env.FEISHU_SYSTEM_LOCALE = 'fr';
    expect(feishuLocale()).toBe('en');
    expect(t('card.question.title')).toBe('Question');
  });

  it('an explicit locale arg overrides the env default', () => {
    process.env.FEISHU_SYSTEM_LOCALE = 'en';
    expect(t('card.question.title', 'zh')).toBe('请选择');
  });
});

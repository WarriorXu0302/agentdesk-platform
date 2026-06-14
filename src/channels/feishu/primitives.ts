/**
 * Feishu primitives — constants, tiny utility helpers, and pure transforms
 * that need no host state (no DB, no network, no mutable config). These
 * used to live at the top of feishu.ts; pulling them out keeps the main
 * file focused on adapter wiring.
 */
import crypto from 'crypto';

import type { OutboundMessage } from '../adapter.js';
import type {
  FeishuApiResponse,
  FeishuConfig,
  FeishuEventMode,
  FeishuMessageEvent,
  FeishuQuestionActionPayload,
  NormalizedQuestionOption,
} from './types.js';

export const DEFAULT_BASE_URL = 'https://open.feishu.cn';
export const DEFAULT_WEBHOOK_PATH = '/webhook/feishu';
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_BODY_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
export const DEFAULT_FEISHU_TEXT_LIMIT = 4_000;
// Refresh the tenant access token once we're within this window of expiry.
// Feishu tokens last ~2h; refreshing 5min early keeps concurrent API calls
// from hitting 401 mid-flight without thrashing the auth endpoint.
export const TOKEN_REFRESH_AHEAD_MS = 5 * 60_000;

export const FEISHU_REACTION_ALIASES: Record<string, string> = {
  '+1': 'THUMBSUP',
  clap: 'CLAP',
  fire: 'FIRE',
  heart: 'HEART',
  hourglass: 'HOURGLASS',
  ok: 'OK',
  thinking: 'THINKING',
  thumbs_up: 'THUMBSUP',
  thumbsup: 'THUMBSUP',
  typing: 'Typing',
  wait: 'WAIT',
  '❤️': 'HEART',
  '❤': 'HEART',
  '🔥': 'FIRE',
  '👏': 'CLAP',
  '👍': 'THUMBSUP',
  '✅': 'OK',
  '🤔': 'THINKING',
  '⌨️': 'Typing',
  '⌨': 'Typing',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeReactionEmojiType(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  return FEISHU_REACTION_ALIASES[raw.toLowerCase()] || FEISHU_REACTION_ALIASES[raw] || raw;
}

export function normalizeWebhookPath(value: string | undefined): string {
  const raw = (value || DEFAULT_WEBHOOK_PATH).trim();
  if (!raw) return DEFAULT_WEBHOOK_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

export function normalizeFeishuEventMode(value: string | undefined): FeishuEventMode {
  const normalized = value?.trim().toLowerCase();
  switch (normalized) {
    case 'long-connection':
    case 'long_connection':
    case 'longconnection':
    case 'long':
    case 'ws':
    case 'websocket':
      return 'long-connection';
    case 'hybrid':
    case 'mixed':
    case 'both':
      return 'hybrid';
    case 'webhook':
    case undefined:
    case '':
      return 'webhook';
    default:
      return 'webhook';
  }
}

export function shouldEnableWebhook(config: FeishuConfig): boolean {
  return config.eventMode !== 'long-connection' && Boolean(config.encryptKey);
}

export function shouldEnableLongConnection(config: FeishuConfig): boolean {
  return config.eventMode !== 'webhook';
}

export function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signFeishuBody(params: {
  encryptKey: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(params.timestamp + params.nonce + params.encryptKey + params.rawBody)
    .digest('hex');
}

export function decryptFeishuPayload(encryptKey: string, encrypted: string): Record<string, unknown> | null {
  try {
    const data = Buffer.from(encrypted, 'base64');
    if (data.length <= 16) return null;
    const iv = data.subarray(0, 16);
    const ciphertext = data.subarray(16);
    const key = crypto.createHash('sha256').update(encryptKey).digest();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return parseJsonObject(plaintext);
  } catch {
    return null;
  }
}

export function extractEffectivePayload(
  rawPayload: Record<string, unknown>,
  encryptKey: string,
): Record<string, unknown> | null {
  const encrypted = readString(rawPayload.encrypt);
  if (!encrypted) return rawPayload;
  return decryptFeishuPayload(encryptKey, encrypted);
}

export function verifyFeishuSignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: string,
  encryptKey: string,
): boolean {
  const timestampHeader = headers['x-lark-request-timestamp'];
  const nonceHeader = headers['x-lark-request-nonce'];
  const signatureHeader = headers['x-lark-signature'];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !nonce || !signature) return false;
  return safeEqualHex(signFeishuBody({ encryptKey, timestamp, nonce, rawBody }), signature);
}

export function timestampToIso(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return nowIso();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    const millis = asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    return new Date(millis).toISOString();
  }
  return nowIso();
}

export function parseTextContent(rawContent: string, messageType: string): string {
  if (!rawContent) return '';
  const parsed = parseJsonObject(rawContent);
  if (!parsed) return rawContent;

  if (messageType === 'text') {
    return typeof parsed.text === 'string' ? parsed.text : '[Text message]';
  }
  if (messageType === 'post') {
    return parsePostContent(parsed);
  }
  if (messageType === 'interactive') {
    return parseInteractiveCardContent(parsed);
  }

  if (typeof parsed.text === 'string' && parsed.text.trim()) return parsed.text;
  if (typeof parsed.title === 'string' && parsed.title.trim()) return parsed.title;
  return `[${messageType || 'unknown'} message]`;
}

export function parsePostContent(parsed: Record<string, unknown>): string {
  const content = parsed.content;
  if (!Array.isArray(content)) return '[Post message]';
  const lines: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    let line = '';
    for (const node of row) {
      if (!isRecord(node)) continue;
      const tag = readString(node.tag) || '';
      if (tag === 'text') {
        line += typeof node.text === 'string' ? node.text : '';
        continue;
      }
      if (tag === 'at') {
        const name = readString(node.user_name) || readString(node.text) || 'someone';
        line += `@${name}`;
        continue;
      }
      if (tag === 'code') {
        line += `\`${typeof node.text === 'string' ? node.text : ''}\``;
        continue;
      }
      if (tag === 'code_block') {
        const lang = readString(node.language) || '';
        const code = typeof node.text === 'string' ? node.text : '';
        line += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
        continue;
      }
      if (tag === 'a' && typeof node.text === 'string') {
        line += node.text;
      }
    }
    if (line.trim()) lines.push(line.trim());
  }
  return lines.join('\n').trim() || '[Post message]';
}

export function parseInteractiveCardContent(parsed: Record<string, unknown>): string {
  const body = isRecord(parsed.body) ? parsed.body : undefined;
  const elements = Array.isArray(parsed.elements)
    ? parsed.elements
    : Array.isArray(body?.elements)
      ? (body.elements as unknown[])
      : [];
  const texts: string[] = [];
  for (const element of elements) {
    if (!isRecord(element)) continue;
    const tag = readString(element.tag) || '';
    if (tag === 'markdown' && typeof element.content === 'string') {
      texts.push(element.content);
      continue;
    }
    if (tag === 'div' && isRecord(element.text) && typeof element.text.content === 'string') {
      texts.push(element.text.content);
      continue;
    }
    if (tag === 'note' && Array.isArray(element.elements)) {
      for (const child of element.elements) {
        if (isRecord(child) && isRecord(child.text) && typeof child.text.content === 'string') {
          texts.push(child.text.content);
        }
      }
    }
  }
  return texts.join('\n').trim() || '[Interactive card]';
}

export function extractPostMentionIds(parsed: Record<string, unknown>): string[] {
  const content = parsed.content;
  if (!Array.isArray(content)) return [];
  const mentions: string[] = [];
  for (const row of content) {
    if (!Array.isArray(row)) continue;
    for (const node of row) {
      if (!isRecord(node) || readString(node.tag) !== 'at') continue;
      const openId = readString(node.open_id) || readString(node.user_id);
      if (openId) mentions.push(openId);
    }
  }
  return mentions;
}

export function mentionsBot(event: FeishuMessageEvent, config: FeishuConfig): boolean {
  const botOpenId = config.botOpenId?.trim();
  const botName = config.botName?.trim();
  const mentions = Array.isArray(event.message.mentions) ? event.message.mentions : [];
  if (botOpenId) {
    for (const mention of mentions) {
      const mentionOpenId = readString(mention.id?.open_id) || readString(mention.id?.user_id);
      if (mentionOpenId === botOpenId) return true;
    }
    if (event.message.message_type === 'post') {
      const parsed = parseJsonObject(event.message.content);
      if (parsed && extractPostMentionIds(parsed).includes(botOpenId)) return true;
    }
  }
  if (botName) {
    for (const mention of mentions) {
      if (readString(mention.name) === botName) return true;
    }
  }
  return false;
}

export function normalizeFeishuPlatformId(params: {
  chatId: string;
  chatType: 'p2p' | 'private' | 'group';
  senderOpenId?: string;
}): string | null {
  if (params.chatType === 'p2p' || params.chatType === 'private') {
    const senderId = params.senderOpenId?.trim();
    return senderId ? `feishu:p2p:${senderId}` : null;
  }
  return `feishu:${params.chatId}`;
}

export function resolveThreadId(event: FeishuMessageEvent): string | null {
  return event.message.root_id?.trim() || event.message.thread_id?.trim() || null;
}

export function isFeishuMessageEvent(value: unknown): value is FeishuMessageEvent {
  if (!isRecord(value) || !isRecord(value.sender) || !isRecord(value.message) || !isRecord(value.sender.sender_id)) {
    return false;
  }
  const message = value.message as Record<string, unknown>;
  return (
    typeof message.message_id === 'string' &&
    typeof message.chat_id === 'string' &&
    typeof message.chat_type === 'string' &&
    typeof message.message_type === 'string' &&
    typeof message.content === 'string'
  );
}

export function isFeishuCardActionEvent(value: unknown): value is import('./types.js').FeishuCardActionEvent {
  return (
    isRecord(value) &&
    isRecord(value.operator) &&
    isRecord(value.action) &&
    isRecord(value.context) &&
    typeof value.token === 'string' &&
    isRecord(value.action.value)
  );
}

export function extractVerificationToken(payload: Record<string, unknown>): string | undefined {
  return readString(payload.token) || (isRecord(payload.header) ? readString(payload.header.token) : undefined);
}

export function parseFeishuQuestionActionPayload(value: unknown, now = Date.now()): FeishuQuestionActionPayload | null {
  if (!isRecord(value)) return null;
  if (value.kind !== 'card.ask_question') return null;
  const questionId = readString(value.questionId);
  const selectedOption = readString(value.selectedOption);
  const selectedLabel = readString(value.selectedLabel);
  const expectedUserId = readString(value.expectedUserId);
  const expiresAt =
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : undefined;
  if (!questionId || !selectedOption) return null;
  if (expiresAt !== undefined && expiresAt < now) return null;
  return {
    kind: 'card.ask_question',
    questionId,
    selectedOption,
    selectedLabel,
    expectedUserId,
    expiresAt,
  };
}

/**
 * True iff `value` is a well-formed ask_question card payload that parseable in
 * every way EXCEPT that it has expired. Lets the card-action handler tell an
 * expired click apart from a genuinely-unsupported payload, so an expired click
 * can get a user-visible "ask the assistant to resend" notice instead of being
 * silently swallowed (parseFeishuQuestionActionPayload returns null for both).
 * (roadmap 6.2)
 */
export function isExpiredQuestionPayload(value: unknown, now = Date.now()): boolean {
  if (!isRecord(value)) return false;
  if (value.kind !== 'card.ask_question') return false;
  if (!readString(value.questionId) || !readString(value.selectedOption)) return false;
  const expiresAt =
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : undefined;
  return expiresAt !== undefined && expiresAt < now;
}

export function normalizeOptions(raw: unknown): NormalizedQuestionOption[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedQuestionOption[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) {
      out.push({ label: entry.trim(), value: entry.trim(), selectedLabel: entry.trim() });
      continue;
    }
    if (!isRecord(entry)) continue;
    const label = readString(entry.label) || readString(entry.value);
    const value = readString(entry.value) || label;
    const selectedLabel = readString(entry.selectedLabel) || label;
    if (!label || !value) continue;
    out.push({ label, value, selectedLabel: selectedLabel || label });
  }
  return out;
}

/**
 * Plain-text fallback for an ask_question when the interactive card can't be
 * delivered (Feishu rejects the schema/size, or the card API drifts). Numbered
 * options + the question + a reply hint, so the user can still respond by typing
 * instead of the question silently failing into the retry path. (roadmap 6.4)
 */
export function buildAskQuestionFallbackText(params: {
  title: string;
  question: string;
  options: NormalizedQuestionOption[];
  // Localized "reply with the option number" hint (roadmap 6.5). The caller
  // resolves the locale (this module stays pure); defaults to English.
  replyHint?: string;
}): string {
  const lines = [
    params.question.trim() || params.title.trim(),
    '',
    ...params.options.map((o, i) => `${i + 1}. ${o.label}`),
    '',
    params.replyHint ?? 'Reply with the option number or its text.',
  ];
  return lines.join('\n');
}

export function buildMarkdownCard(text: string, title?: string): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: {
      elements: [{ tag: 'markdown', content: text }],
    },
  };
  if (title) {
    card.header = {
      title: { tag: 'plain_text', content: title },
      template: 'blue',
    };
  }
  return card;
}

export function buildFeishuAskQuestionCardWithPayloads(params: {
  title: string;
  questionId: string;
  question: string;
  options: NormalizedQuestionOption[];
  expectedUserId?: string;
  expiresAt?: number;
}): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: params.title },
      template: 'blue',
    },
    body: {
      elements: [
        { tag: 'markdown', content: params.question },
        {
          tag: 'action',
          actions: params.options.map((option, index) => ({
            tag: 'button',
            text: { tag: 'plain_text', content: option.label },
            type: index === 0 ? 'primary' : 'default',
            value: {
              kind: 'card.ask_question',
              questionId: params.questionId,
              selectedOption: option.value,
              selectedLabel: option.selectedLabel,
              ...(params.expectedUserId ? { expectedUserId: params.expectedUserId } : {}),
              ...(params.expiresAt ? { expiresAt: params.expiresAt } : {}),
            },
          })),
        },
      ],
    },
  };
}

/**
 * Build the roster-DM directed opt-in card (ADR-0044 Stage 3). A single primary
 * "Opt in" button whose action `value` is the HOST-STAMPED roster.optin payload
 * (scopeId / slotLabel / agentGroupId / expectedUserId / expiresAt). The card is
 * posted into the origin group; only the member whose open_id equals the card's
 * expectedUserId can turn a click into a grant (captureDirectedCardConsent runs
 * cardActionOperatorAllowed fail-closed).
 *
 * SECURITY: this builder embeds `optIn` VERBATIM, so it must only ever be invoked
 * with a payload the host invite handler stamped (src/roster-invite.ts) — see the
 * load-bearing invariant documented there. It is pure rendering; it derives no
 * security field itself.
 */
export function buildFeishuRosterOptInCard(params: {
  slotLabel: string;
  optIn: Record<string, unknown>;
  prompt?: string;
}): Record<string, unknown> {
  const body =
    params.prompt && params.prompt.trim()
      ? params.prompt.trim()
      : `You've been invited to receive direct messages from this assistant for the **${params.slotLabel}** role in this conversation. ` +
        `Tap **Opt in** to allow it — only you can accept this invite, and you can opt out at any time.`;
  return {
    schema: '2.0',
    config: { width_mode: 'fill' },
    header: {
      title: { tag: 'plain_text', content: 'Direct message opt-in' },
      template: 'blue',
    },
    body: {
      elements: [
        { tag: 'markdown', content: body },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: 'Opt in' },
              type: 'primary',
              value: params.optIn,
            },
          ],
        },
      ],
    },
  };
}

export function buildDisplayCard(content: Record<string, unknown>): Record<string, unknown> {
  const card = content.card;
  if (!isRecord(card)) return buildMarkdownCard((content.fallbackText as string) || '[Card]');
  const title = readString(card.title);
  const description = readString(card.description);
  const children: string[] = [];
  if (description) children.push(description);
  if (Array.isArray(card.children)) {
    for (const child of card.children) {
      if (typeof child === 'string' && child.trim()) {
        children.push(child.trim());
        continue;
      }
      if (isRecord(child) && typeof child.text === 'string' && child.text.trim()) {
        children.push(child.text.trim());
      }
    }
  }
  if (Array.isArray(card.actions)) {
    for (const action of card.actions) {
      if (!isRecord(action)) continue;
      const label = readString(action.label);
      const url = readString(action.url);
      if (label && url) children.push(`- [${label}](${url})`);
    }
  }
  return buildMarkdownCard(children.join('\n\n') || (content.fallbackText as string) || '[Card]', title);
}

export function appendAttachmentSummary(text: string, files: OutboundMessage['files']): string {
  if (!files || files.length === 0) return text;
  const suffix = `Attachments: ${files.map((file) => file.filename).join(', ')}`;
  return text.trim().length > 0 ? `${text}\n\n${suffix}` : suffix;
}

export function stripChannelPrefix(platformId: string): string {
  return platformId.startsWith('feishu:') ? platformId.slice('feishu:'.length) : platformId;
}

export function resolveReceiveTarget(platformId: string): import('./types.js').FeishuReceiveTarget {
  const raw = stripChannelPrefix(platformId).trim();
  const lower = raw.toLowerCase();
  if (lower.startsWith('p2p:')) {
    const id = raw.slice('p2p:'.length).trim();
    return {
      receiveId: id,
      receiveIdType: id.startsWith('ou_') ? 'open_id' : 'user_id',
    };
  }
  if (lower.startsWith('chat:') || lower.startsWith('group:') || lower.startsWith('channel:')) {
    const receiveId = raw.slice(raw.indexOf(':') + 1).trim();
    return { receiveId, receiveIdType: 'chat_id' };
  }
  if (lower.startsWith('open_id:')) {
    return { receiveId: raw.slice('open_id:'.length).trim(), receiveIdType: 'open_id' };
  }
  if (lower.startsWith('user:') || lower.startsWith('dm:')) {
    const receiveId = raw.slice(raw.indexOf(':') + 1).trim();
    return {
      receiveId,
      receiveIdType: receiveId.startsWith('ou_') ? 'open_id' : 'user_id',
    };
  }
  if (raw.startsWith('oc_')) return { receiveId: raw, receiveIdType: 'chat_id' };
  if (raw.startsWith('ou_')) return { receiveId: raw, receiveIdType: 'open_id' };
  return { receiveId: raw, receiveIdType: 'user_id' };
}

export function isWithdrawnReplyError(response: FeishuApiResponse): boolean {
  if (response.code === 230011 || response.code === 231003) return true;
  const msg = (response.msg || '').toLowerCase();
  return msg.includes('withdrawn') || msg.includes('not found');
}

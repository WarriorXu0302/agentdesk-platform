import crypto from 'crypto';
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';
import { markInboundSeen } from '../db/inbound-dedup.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const DEFAULT_BASE_URL = 'https://open.feishu.cn';
const DEFAULT_WEBHOOK_PATH = '/webhook/feishu';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 128 * 1024;
const DEFAULT_FEISHU_TEXT_LIMIT = 4_000;
// Refresh the tenant access token once we're within this window of expiry.
// Feishu tokens last ~2h; refreshing 5min early keeps concurrent API calls
// from hitting 401 mid-flight without thrashing the auth endpoint.
const TOKEN_REFRESH_AHEAD_MS = 5 * 60_000;
const FEISHU_REACTION_ALIASES: Record<string, string> = {
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

type FeishuEventMode = 'webhook' | 'long-connection' | 'hybrid';

interface FeishuConfig {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  webhookPath: string;
  baseUrl: string;
  requestTimeoutMs: number;
  bodyTimeoutMs: number;
  maxBodyBytes: number;
  botOpenId?: string;
  botName?: string;
  eventMode: FeishuEventMode;
}

interface FeishuTenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

interface FeishuReactionOperator {
  operator_type?: 'app' | 'user';
}

interface FeishuReactionItem {
  reaction_id?: string;
  operator?: FeishuReactionOperator;
  reaction_type?: {
    emoji_type?: string;
  };
}

interface FeishuMessageEvent {
  sender: {
    sender_id: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
    };
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id: string;
    chat_type: 'p2p' | 'private' | 'group';
    message_type: string;
    content: string;
    create_time?: string;
    mentions?: Array<{
      key?: string;
      name?: string;
      id?: {
        open_id?: string;
        user_id?: string;
        union_id?: string;
      };
    }>;
  };
}

interface FeishuCardActionEvent {
  operator: {
    open_id?: string;
    user_id?: string;
    union_id?: string;
  };
  token: string;
  action: {
    value: Record<string, unknown>;
    tag?: string;
  };
  context: {
    open_id?: string;
    user_id?: string;
    chat_id?: string;
  };
}

interface FeishuReceiveTarget {
  receiveId: string;
  receiveIdType: 'chat_id' | 'open_id' | 'user_id';
}

interface FeishuQuestionActionPayload {
  kind: 'frontlane.ask_question';
  questionId: string;
  selectedOption: string;
  selectedLabel?: string;
  expectedUserId?: string;
  expiresAt?: number;
}

interface NormalizedQuestionOption {
  label: string;
  value: string;
  selectedLabel: string;
}

interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeReactionEmojiType(value: unknown): string | undefined {
  const raw = readString(value);
  if (!raw) return undefined;
  return FEISHU_REACTION_ALIASES[raw.toLowerCase()] || FEISHU_REACTION_ALIASES[raw] || raw;
}

function normalizeWebhookPath(value: string | undefined): string {
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

function shouldEnableWebhook(config: FeishuConfig): boolean {
  return config.eventMode !== 'long-connection' && Boolean(config.encryptKey);
}

function shouldEnableLongConnection(config: FeishuConfig): boolean {
  return config.eventMode !== 'webhook';
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function nowIso(): string {
  return new Date().toISOString();
}

function splitForLimit(text: string, limit: number): string[] {
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

function parseJsonObject(raw: string): Record<string, unknown> | null {
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

function extractEffectivePayload(
  rawPayload: Record<string, unknown>,
  encryptKey: string,
): Record<string, unknown> | null {
  const encrypted = readString(rawPayload.encrypt);
  if (!encrypted) return rawPayload;
  return decryptFeishuPayload(encryptKey, encrypted);
}

function verifyFeishuSignature(
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

function timestampToIso(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (!trimmed) return nowIso();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber)) {
    const millis = asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    return new Date(millis).toISOString();
  }
  return nowIso();
}

function parseTextContent(rawContent: string, messageType: string): string {
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

function parsePostContent(parsed: Record<string, unknown>): string {
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

function parseInteractiveCardContent(parsed: Record<string, unknown>): string {
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

function extractPostMentionIds(parsed: Record<string, unknown>): string[] {
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

function mentionsBot(event: FeishuMessageEvent, config: FeishuConfig): boolean {
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

function resolveThreadId(event: FeishuMessageEvent): string | null {
  return event.message.root_id?.trim() || event.message.thread_id?.trim() || null;
}

function isFeishuMessageEvent(value: unknown): value is FeishuMessageEvent {
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

function isFeishuCardActionEvent(value: unknown): value is FeishuCardActionEvent {
  return (
    isRecord(value) &&
    isRecord(value.operator) &&
    isRecord(value.action) &&
    isRecord(value.context) &&
    typeof value.token === 'string' &&
    isRecord(value.action.value)
  );
}

function extractVerificationToken(payload: Record<string, unknown>): string | undefined {
  return readString(payload.token) || (isRecord(payload.header) ? readString(payload.header.token) : undefined);
}

export function parseFeishuQuestionActionPayload(value: unknown, now = Date.now()): FeishuQuestionActionPayload | null {
  if (!isRecord(value)) return null;
  if (value.kind !== `${PLATFORM_PROTOCOL_NAMESPACE}.ask_question`) return null;
  const questionId = readString(value.questionId);
  const selectedOption = readString(value.selectedOption);
  const selectedLabel = readString(value.selectedLabel);
  const expectedUserId = readString(value.expectedUserId);
  const expiresAt =
    typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) ? value.expiresAt : undefined;
  if (!questionId || !selectedOption) return null;
  if (expiresAt !== undefined && expiresAt < now) return null;
  return {
    kind: 'frontlane.ask_question',
    questionId,
    selectedOption,
    selectedLabel,
    expectedUserId,
    expiresAt,
  };
}

function normalizeOptions(raw: unknown): NormalizedQuestionOption[] {
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

function buildMarkdownCard(text: string, title?: string): Record<string, unknown> {
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

function buildFeishuAskQuestionCardWithPayloads(params: {
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
              kind: `${PLATFORM_PROTOCOL_NAMESPACE}.ask_question`,
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

function buildDisplayCard(content: Record<string, unknown>): Record<string, unknown> {
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

function appendAttachmentSummary(text: string, files: OutboundMessage['files']): string {
  if (!files || files.length === 0) return text;
  const suffix = `Attachments: ${files.map((file) => file.filename).join(', ')}`;
  return text.trim().length > 0 ? `${text}\n\n${suffix}` : suffix;
}

function stripChannelPrefix(platformId: string): string {
  return platformId.startsWith('feishu:') ? platformId.slice('feishu:'.length) : platformId;
}

function resolveReceiveTarget(platformId: string): FeishuReceiveTarget {
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

function isWithdrawnReplyError(response: FeishuApiResponse): boolean {
  if (response.code === 230011 || response.code === 231003) return true;
  const msg = (response.msg || '').toLowerCase();
  return msg.includes('withdrawn') || msg.includes('not found');
}

function readEnvConfig(): FeishuConfig | null {
  const dotenv = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_EVENT_MODE',
    'FEISHU_ENCRYPT_KEY',
    'FEISHU_VERIFICATION_TOKEN',
    'FEISHU_WEBHOOK_PATH',
    'FEISHU_BASE_URL',
    'FEISHU_REQUEST_TIMEOUT_MS',
    'FEISHU_BODY_TIMEOUT_MS',
    'FEISHU_MAX_BODY_BYTES',
    'FEISHU_BOT_OPEN_ID',
    'FEISHU_BOT_NAME',
  ]);
  const appId = (process.env.FEISHU_APP_ID || dotenv.FEISHU_APP_ID)?.trim();
  const appSecret = (process.env.FEISHU_APP_SECRET || dotenv.FEISHU_APP_SECRET)?.trim();
  const encryptKey = (process.env.FEISHU_ENCRYPT_KEY || dotenv.FEISHU_ENCRYPT_KEY)?.trim();
  const verificationToken = (process.env.FEISHU_VERIFICATION_TOKEN || dotenv.FEISHU_VERIFICATION_TOKEN)?.trim();
  const eventMode = normalizeFeishuEventMode(process.env.FEISHU_EVENT_MODE || dotenv.FEISHU_EVENT_MODE);
  if (!appId || !appSecret) return null;
  if (eventMode === 'webhook' && !encryptKey) {
    log.warn('Feishu adapter disabled: FEISHU_ENCRYPT_KEY is required for webhook mode');
    return null;
  }
  if (eventMode === 'hybrid' && !encryptKey) {
    log.warn('Feishu adapter starting without webhook callbacks because FEISHU_ENCRYPT_KEY is missing', {
      eventMode,
    });
  }
  return {
    appId,
    appSecret,
    encryptKey,
    verificationToken,
    webhookPath: normalizeWebhookPath(process.env.FEISHU_WEBHOOK_PATH || dotenv.FEISHU_WEBHOOK_PATH),
    baseUrl: ((process.env.FEISHU_BASE_URL || dotenv.FEISHU_BASE_URL)?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    requestTimeoutMs: readPositiveInt(
      process.env.FEISHU_REQUEST_TIMEOUT_MS || dotenv.FEISHU_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    bodyTimeoutMs: readPositiveInt(
      process.env.FEISHU_BODY_TIMEOUT_MS || dotenv.FEISHU_BODY_TIMEOUT_MS,
      DEFAULT_BODY_TIMEOUT_MS,
    ),
    maxBodyBytes: readPositiveInt(
      process.env.FEISHU_MAX_BODY_BYTES || dotenv.FEISHU_MAX_BODY_BYTES,
      DEFAULT_MAX_BODY_BYTES,
    ),
    botOpenId: (process.env.FEISHU_BOT_OPEN_ID || dotenv.FEISHU_BOT_OPEN_ID)?.trim() || undefined,
    botName: (process.env.FEISHU_BOT_NAME || dotenv.FEISHU_BOT_NAME)?.trim() || undefined,
    eventMode,
  };
}

function createAdapter(config: FeishuConfig): ChannelAdapter {
  let setupConfig: ChannelSetup | null = null;
  let connected = false;
  let tokenCache: TokenCacheEntry | null = null;
  let tokenInflight: Promise<string> | null = null;
  let wsClient: WSClient | null = null;

  async function refreshTenantAccessToken(): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetch(`${config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          app_id: config.appId,
          app_secret: config.appSecret,
        }),
        signal: controller.signal,
      });
      const data = (await response.json()) as FeishuTenantTokenResponse;
      if (!response.ok || data.code !== 0 || !data.tenant_access_token) {
        throw new Error(`Feishu token request failed: ${data.msg || response.statusText}`);
      }
      tokenCache = {
        token: data.tenant_access_token,
        expiresAt: Date.now() + Math.max(60, (data.expire || 7200) - 60) * 1000,
      };
      return tokenCache.token;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchTenantAccessToken(): Promise<string> {
    // Proactive refresh: treat the token as expired once we're within
    // TOKEN_REFRESH_AHEAD_MS of its real expiry, so concurrent API calls
    // don't race a mid-flight 401.
    if (tokenCache && tokenCache.expiresAt - TOKEN_REFRESH_AHEAD_MS > Date.now()) {
      return tokenCache.token;
    }
    // Single-flight: coalesce concurrent refresh requests onto one auth
    // call. Without this, a spike of inbound messages on a cold cache
    // hammers /tenant_access_token/internal (and Feishu rate-limits it).
    if (tokenInflight) return tokenInflight;
    tokenInflight = refreshTenantAccessToken().finally(() => {
      tokenInflight = null;
    });
    return tokenInflight;
  }

  async function callApi<T extends FeishuApiResponse>(
    path: string,
    init: {
      method?: 'DELETE' | 'GET' | 'PATCH' | 'POST';
      body?: Record<string, unknown>;
      query?: Record<string, number | string | undefined>;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      headers.Authorization = `Bearer ${await fetchTenantAccessToken()}`;
      const queryParams = new URLSearchParams();
      if (init.query) {
        for (const [key, value] of Object.entries(init.query)) {
          if (value !== undefined) {
            queryParams.set(key, String(value));
          }
        }
      }
      const query = queryParams.toString();
      const url = `${config.baseUrl}${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
      const response = await fetch(url, {
        method: init.method || 'POST',
        headers,
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      const parsed = text ? (JSON.parse(text) as T) : ({ code: 0 } as T);
      if (!response.ok && parsed.code === undefined) {
        throw new Error(`Feishu API ${path} failed with ${response.status} ${response.statusText}`);
      }
      return parsed;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function createMessage(
    target: FeishuReceiveTarget,
    msgType: 'text' | 'interactive',
    content: string,
    threadId: string | null,
  ): Promise<string | undefined> {
    if (threadId) {
      const reply = await callApi<FeishuApiResponse & { data?: { message_id?: string } }>(
        `/open-apis/im/v1/messages/${encodeURIComponent(threadId)}/reply`,
        {
          method: 'POST',
          body: {
            content,
            msg_type: msgType,
            reply_in_thread: true,
          },
        },
      );
      if (reply.code === 0) return reply.data?.message_id;
      if (!isWithdrawnReplyError(reply)) {
        throw new Error(`Feishu reply failed: ${reply.msg || `code ${reply.code}`}`);
      }
    }

    const created = await callApi<FeishuApiResponse & { data?: { message_id?: string } }>(
      `/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(target.receiveIdType)}`,
      {
        method: 'POST',
        body: {
          receive_id: target.receiveId,
          msg_type: msgType,
          content,
        },
      },
    );
    if (created.code !== 0) {
      throw new Error(`Feishu send failed: ${created.msg || `code ${created.code}`}`);
    }
    return created.data?.message_id;
  }

  async function patchMessage(messageId: string, content: string): Promise<void> {
    const response = await callApi<FeishuApiResponse>(`/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      body: { content },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu edit failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  async function addReaction(messageId: string, emojiType: string): Promise<string | undefined> {
    const response = await callApi<FeishuApiResponse & { data?: { reaction_id?: string } }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'POST',
        body: {
          reaction_type: {
            emoji_type: emojiType,
          },
        },
      },
    );
    if (response.code !== 0) {
      throw new Error(`Feishu add reaction failed: ${response.msg || `code ${response.code}`}`);
    }
    return response.data?.reaction_id;
  }

  async function removeReaction(messageId: string, reactionId: string): Promise<void> {
    const response = await callApi<FeishuApiResponse>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(reactionId)}`,
      {
        method: 'DELETE',
      },
    );
    if (response.code !== 0) {
      throw new Error(`Feishu remove reaction failed: ${response.msg || `code ${response.code}`}`);
    }
  }

  async function listReactions(messageId: string, emojiType: string): Promise<FeishuReactionItem[]> {
    const response = await callApi<FeishuApiResponse & { data?: { items?: FeishuReactionItem[] } }>(
      `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      {
        method: 'GET',
        query: {
          reaction_type: emojiType,
          page_size: 50,
        },
      },
    );
    if (response.code !== 0) {
      throw new Error(`Feishu list reactions failed: ${response.msg || `code ${response.code}`}`);
    }
    return Array.isArray(response.data?.items) ? response.data.items : [];
  }

  async function readRawBody(req: import('http').IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        fn();
      };
      const onData = (chunk: Buffer) => {
        size += chunk.length;
        if (size > config.maxBodyBytes) {
          finish(() => reject(new Error('Payload too large')));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = () => finish(() => resolve(Buffer.concat(chunks).toString('utf8')));
      const onError = (err: Error) => finish(() => reject(err));
      const timer = setTimeout(() => {
        finish(() => reject(new Error('Request body timeout')));
      }, config.bodyTimeoutMs);
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });
  }

  async function handleMessageReceive(event: FeishuMessageEvent): Promise<void> {
    if (!setupConfig) return;
    const senderId =
      readString(event.sender.sender_id.open_id) ||
      readString(event.sender.sender_id.user_id) ||
      readString(event.sender.sender_id.union_id);
    if (config.botOpenId && senderId === config.botOpenId) return;

    const platformId = normalizeFeishuPlatformId({
      chatId: event.message.chat_id,
      chatType: event.message.chat_type,
      senderOpenId: senderId,
    });
    if (!platformId) {
      log.warn('Feishu message dropped: missing sender identity for p2p chat', {
        chatId: event.message.chat_id,
        messageId: event.message.message_id,
      });
      return;
    }
    if (!markInboundSeen('feishu', `msg:${event.message.message_id}`)) return;

    const isGroup = event.message.chat_type === 'group';
    const text = parseTextContent(event.message.content, event.message.message_type);
    const isMention = isGroup ? mentionsBot(event, config) : true;
    log.info('Feishu inbound message accepted', {
      messageId: event.message.message_id,
      chatId: event.message.chat_id,
      chatType: event.message.chat_type,
      senderId: senderId || null,
      isGroup,
      isMention,
    });
    await setupConfig.onInbound(platformId, resolveThreadId(event), {
      id: event.message.message_id,
      kind: 'chat',
      timestamp: timestampToIso(event.message.create_time),
      content: {
        senderId: senderId || undefined,
        sender: senderId || 'feishu-user',
        text,
        chatId: event.message.chat_id,
        chatType: event.message.chat_type,
        messageType: event.message.message_type,
        messageId: event.message.message_id,
        rootId: event.message.root_id,
        parentId: event.message.parent_id,
        threadId: event.message.thread_id,
        mentions: event.message.mentions ?? [],
      },
      isMention,
      isGroup,
    });
  }

  async function startLongConnection(): Promise<void> {
    if (wsClient) return;

    const eventDispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.error }).register({
      'im.message.receive_v1': async (data: unknown) => {
        log.info('Feishu long-connection payload accepted', {
          eventType: 'im.message.receive_v1',
        });
        if (!isFeishuMessageEvent(data)) {
          log.warn('Feishu long-connection message ignored: unsupported payload shape');
          return;
        }
        await handleMessageReceive(data);
      },
    });

    wsClient = new WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: LoggerLevel.error,
      source: PLATFORM_PROTOCOL_NAMESPACE,
      onReady: () => {
        log.info('Feishu long-connection ready');
      },
      onReconnecting: () => {
        log.warn('Feishu long-connection reconnecting');
      },
      onReconnected: () => {
        log.info('Feishu long-connection reconnected');
      },
      onError: (err: Error) => {
        log.error('Feishu long-connection error', { err });
      },
    });

    await wsClient.start({ eventDispatcher });
  }

  async function handleCardAction(event: FeishuCardActionEvent): Promise<void> {
    if (!setupConfig) return;
    const token = event.token.trim();
    if (!token || !markInboundSeen('feishu', `action:${token}`)) return;
    const action = parseFeishuQuestionActionPayload(event.action.value);
    if (!action) {
      log.warn('Feishu card action ignored: unsupported payload', {
        token,
        chatId: event.context.chat_id,
      });
      return;
    }
    const operatorUserId =
      readString(event.operator.open_id) ||
      readString(event.operator.user_id) ||
      readString(event.operator.union_id) ||
      '';
    if (action.expectedUserId && operatorUserId && action.expectedUserId !== operatorUserId) {
      log.warn('Feishu card action rejected: wrong user', {
        token,
        expectedUserId: action.expectedUserId,
        operatorUserId,
      });
      return;
    }
    setupConfig.onAction(action.questionId, action.selectedOption, operatorUserId);
  }

  async function handleWebhook(req: import('http').IncomingMessage, res: import('http').ServerResponse): Promise<void> {
    log.info('Feishu webhook request received', {
      method: req.method || 'unknown',
      path: req.url || config.webhookPath,
      contentType: Array.isArray(req.headers['content-type'])
        ? req.headers['content-type'][0]
        : req.headers['content-type'],
    });
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }
    const contentType = req.headers['content-type'];
    const contentTypeValue = Array.isArray(contentType) ? contentType[0] : contentType;
    if (!contentTypeValue || !contentTypeValue.toLowerCase().includes('application/json')) {
      res.writeHead(415, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Unsupported Media Type');
      return;
    }

    try {
      const rawBody = await readRawBody(req);
      if (!config.encryptKey || !verifyFeishuSignature(req.headers, rawBody, config.encryptKey)) {
        log.warn('Feishu webhook rejected: invalid signature', {
          path: req.url || config.webhookPath,
          timestamp: Array.isArray(req.headers['x-lark-request-timestamp'])
            ? req.headers['x-lark-request-timestamp'][0]
            : req.headers['x-lark-request-timestamp'],
        });
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid signature');
        return;
      }

      const outerPayload = parseJsonObject(rawBody);
      if (!outerPayload) {
        log.warn('Feishu webhook rejected: invalid JSON');
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid JSON');
        return;
      }
      const payload = extractEffectivePayload(outerPayload, config.encryptKey);
      if (!payload) {
        log.warn('Feishu webhook rejected: invalid encrypted payload');
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid encrypted payload');
        return;
      }

      const verificationToken = extractVerificationToken(payload);
      if (config.verificationToken && verificationToken && verificationToken !== config.verificationToken) {
        log.warn('Feishu webhook rejected: invalid verification token');
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Invalid verification token');
        return;
      }

      if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
        log.info('Feishu webhook url_verification handled');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ challenge: payload.challenge }));
        return;
      }

      if (isFeishuCardActionEvent(payload)) {
        await handleCardAction(payload);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end('{}');
        return;
      }

      const header = isRecord(payload.header) ? payload.header : null;
      const eventType = header ? readString(header.event_type) : undefined;
      const eventData = payload.event;
      log.info('Feishu webhook payload accepted', {
        eventType: eventType || (isFeishuCardActionEvent(payload) ? 'card.action.trigger' : 'unknown'),
      });
      if (eventType === 'im.message.receive_v1' && isFeishuMessageEvent(eventData)) {
        await handleMessageReceive(eventData);
      } else if (eventType === 'card.action.trigger' && isFeishuCardActionEvent(eventData)) {
        await handleCardAction(eventData);
      } else {
        log.debug('Feishu webhook event ignored', { eventType: eventType || 'unknown' });
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{}');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = message === 'Payload too large' ? 413 : message === 'Request body timeout' ? 408 : 500;
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 413 ? 'Payload too large' : status === 408 ? 'Request body timeout' : 'Internal Server Error');
      if ((status === 413 || status === 408) && !req.destroyed) {
        req.destroy();
      }
      log.error('Feishu webhook handler failed', { err });
    }
  }

  const adapter: ChannelAdapter = {
    name: 'feishu',
    channelType: 'feishu',
    supportsThreads: true,

    async setup(hostConfig: ChannelSetup): Promise<void> {
      setupConfig = hostConfig;
      const webhookEnabled = shouldEnableWebhook(config);
      let longConnectionEnabled = false;

      if (webhookEnabled) {
        registerWebhookHandler(config.webhookPath, handleWebhook);
      }

      if (shouldEnableLongConnection(config)) {
        try {
          await startLongConnection();
          longConnectionEnabled = true;
        } catch (err) {
          wsClient = null;
          if (!webhookEnabled) throw err;
          log.error('Feishu long-connection startup failed; continuing with webhook only', { err });
        }
      }

      if (!webhookEnabled && !longConnectionEnabled) {
        throw new Error('Feishu adapter failed to start: no active webhook or long-connection transport');
      }

      connected = true;
      log.info('Feishu adapter initialized', {
        eventMode: config.eventMode,
        webhookEnabled,
        webhookPath: config.webhookPath,
        longConnectionEnabled,
        botOpenId: config.botOpenId || null,
      });
    },

    async teardown(): Promise<void> {
      connected = false;
      setupConfig = null;
      tokenCache = null;
      wsClient?.close({ force: true });
      wsClient = null;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const content = isRecord(message.content) ? message.content : {};

      if (content.operation === 'reaction') {
        const action = readString(content.action)?.toLowerCase();
        const messageId = readString(content.messageId);
        const reactionId = readString(content.reactionId);
        const emojiType = normalizeReactionEmojiType(content.emojiType ?? content.emoji);

        if (!action || !messageId) {
          throw new Error('Feishu reaction operation requires action and messageId');
        }

        if (action === 'add') {
          if (!emojiType) {
            throw new Error('Feishu reaction add requires emoji or emojiType');
          }
          return addReaction(messageId, emojiType);
        }

        if (action === 'remove') {
          if (reactionId) {
            await removeReaction(messageId, reactionId);
            return reactionId;
          }
          if (!emojiType) {
            throw new Error('Feishu reaction remove requires reactionId or emoji/emojiType');
          }
          const items = await listReactions(messageId, emojiType);
          const mine = items.find((item) => item.reaction_id && item.operator?.operator_type === 'app');
          if (!mine?.reaction_id) return undefined;
          await removeReaction(messageId, mine.reaction_id);
          return mine.reaction_id;
        }

        throw new Error(`Unsupported Feishu reaction action: ${action}`);
      }

      if (content.operation === 'edit' && typeof content.messageId === 'string') {
        if (isRecord(content.card)) {
          await patchMessage(content.messageId, JSON.stringify(content.card));
          return content.messageId;
        }
        const text = appendAttachmentSummary(
          (typeof content.markdown === 'string'
            ? content.markdown
            : typeof content.text === 'string'
              ? content.text
              : ''
          ).trim(),
          message.files,
        );
        await patchMessage(content.messageId, JSON.stringify(buildMarkdownCard(text || '[Updated]')));
        return content.messageId;
      }

      const target = resolveReceiveTarget(platformId);

      if (content.type === 'ask_question' && typeof content.questionId === 'string') {
        const title = typeof content.title === 'string' && content.title.trim() ? content.title.trim() : 'Question';
        const question = typeof content.question === 'string' ? content.question : '';
        const options = normalizeOptions(content.options);
        if (options.length === 0) {
          throw new Error('Feishu ask_question requires at least one option');
        }
        const expectedUserId = target.receiveIdType === 'open_id' ? target.receiveId : undefined;
        const card = buildFeishuAskQuestionCardWithPayloads({
          title,
          questionId: content.questionId,
          question,
          options,
          expectedUserId,
          expiresAt: Date.now() + 5 * 60_000,
        });
        return createMessage(target, 'interactive', JSON.stringify(card), threadId);
      }

      if (content.type === 'card') {
        const card = buildDisplayCard(content);
        return createMessage(target, 'interactive', JSON.stringify(card), threadId);
      }

      const rawText =
        (typeof content.markdown === 'string' ? content.markdown : undefined) ||
        (typeof content.text === 'string' ? content.text : undefined) ||
        '';
      const text = appendAttachmentSummary(rawText, message.files);
      if (!text.trim()) return undefined;

      const chunks = splitForLimit(text, DEFAULT_FEISHU_TEXT_LIMIT);
      let firstId: string | undefined;
      for (let index = 0; index < chunks.length; index += 1) {
        const messageId = await createMessage(
          target,
          'text',
          JSON.stringify({ text: chunks[index] }),
          index === 0 ? threadId : null,
        );
        if (index === 0) firstId = messageId;
      }
      return firstId;
    },

    async setTyping(): Promise<void> {
      // Feishu bot API doesn't expose a useful typing indicator for this flow.
    },

    async openDM(userHandle: string): Promise<string> {
      const normalized = userHandle.trim();
      return `feishu:p2p:${normalized}`;
    },
  };

  return adapter;
}

const envConfig = readEnvConfig();
registerChannelAdapter('feishu', {
  factory: () => (envConfig ? createAdapter(envConfig) : null),
});

/**
 * Feishu channel adapter.
 *
 * Surface area is split across a few files:
 *   - feishu/types.ts       → shared type / interface declarations
 *   - feishu/primitives.ts  → pure helpers (parsing, signing, card-building)
 *
 * This file owns the stateful plumbing: env config, token cache, HTTP client
 * methods, webhook + long-connection handlers, and the outbound `deliver`
 * path. Re-exports the primitive surface so callers (and tests) can keep
 * importing from `./feishu` as before.
 */
import { EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

import { PLATFORM_PROTOCOL_NAMESPACE } from '../branding.js';
import { markInboundSeen } from '../db/inbound-dedup.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { chainAttrs, runInDetachedRoot } from '../observability/openinference.js';
import { withSpan } from '../observability/with-span.js';
import { inboundTotal, policyCheckFailedTotal } from '../metrics.js';
import { registerWebhookHandler } from '../webhook-server.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import type {
  FeishuApiResponse,
  FeishuCardActionEvent,
  FeishuConfig,
  FeishuMessageEvent,
  FeishuReactionItem,
  FeishuReceiveTarget,
  FeishuTenantTokenResponse,
  TokenCacheEntry,
} from './feishu/types.js';
import {
  DEFAULT_BASE_URL,
  DEFAULT_BODY_TIMEOUT_MS,
  DEFAULT_FEISHU_TEXT_LIMIT,
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TOKEN_REFRESH_AHEAD_MS,
  appendAttachmentSummary,
  buildAskQuestionFallbackText,
  buildDisplayCard,
  buildFeishuAskQuestionCardWithPayloads,
  buildFeishuRosterOptInCard,
  buildMarkdownCard,
  extractEffectivePayload,
  extractVerificationToken,
  isFeishuCardActionEvent,
  isFeishuMessageEvent,
  isExpiredQuestionPayload,
  isRecord,
  isWithdrawnReplyError,
  mentionsBot,
  normalizeFeishuEventMode,
  normalizeFeishuPlatformId,
  normalizeOptions,
  normalizeReactionEmojiType,
  normalizeWebhookPath,
  parseFeishuQuestionActionPayload,
  parseJsonObject,
  parseTextContent,
  readPositiveInt,
  readString,
  resolveReceiveTarget,
  resolveThreadId,
  shouldEnableLongConnection,
  shouldEnableWebhook,
  splitForLimit,
  timestampToIso,
  verifyFeishuSignature,
} from './feishu/primitives.js';
import { captureDirectedCardConsent, captureP2pIngressConsent, parseRosterOptIn } from './feishu/roster-consent.js';
import { t } from './feishu/i18n.js';
import { optOutParticipant, parseRosterOptOut } from '../roster-dm.js';
import { revokeGrantsForLeaver } from '../db/dm-grants.js';
import { hasTable } from '../db/connection.js';
import { getDb } from '../db/connection.js';

// Re-export the subset of primitives that existing callers (including
// tests) reach for via `./feishu`. Keeping the public surface stable means
// external tests never broke when we moved implementations around.
// Re-export primitives for tests/callers that historically imported from
// `./feishu`. `parseFeishuQuestionActionPayload` is *also* used internally
// in this file (via the top-level import above).
export {
  decryptFeishuPayload,
  normalizeFeishuEventMode,
  normalizeFeishuPlatformId,
  parseFeishuQuestionActionPayload,
  signFeishuBody,
} from './feishu/primitives.js';

/**
 * Decide whether a card-action operator may act on a card.
 *
 * Fail-closed: when a card is scoped to a specific user (`expectedUserId`
 * set), the operator must be present and exactly equal. An empty/missing
 * `operatorUserId` means the callback carried no verifiable identity, so we
 * deny — never short-circuit the wrong-user check on a missing operator.
 * Unscoped cards (`expectedUserId` empty) remain open.
 */
export function cardActionOperatorAllowed(expectedUserId: string | undefined, operatorUserId: string): boolean {
  if (!expectedUserId) return true;
  return operatorUserId !== '' && operatorUserId === expectedUserId;
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

/**
 * Construct a Feishu adapter from a fully-resolved config.
 *
 * Exported as a test seam (and for operators embedding the adapter with a
 * programmatic config rather than env). Pure constructor — no env reads, no
 * registration side effects. The registration below still goes through the
 * env-driven factory; this just lets a test drive the real `setup` /
 * `deliver` / webhook-handler code paths with an explicit config and a
 * captured `registerWebhookHandler`. Does not change runtime behavior.
 */
export function createFeishuAdapter(config: FeishuConfig): ChannelAdapter {
  return createAdapter(config);
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

  /**
   * Upload an image to Feishu's image API, returning the `image_key` used to
   * send the actual `msg_type: "image"` message. Multipart because the Feishu
   * API expects the raw bytes as a form field — `callApi` only knows
   * application/json, so this routes around it with raw fetch + FormData.
   *
   * Bytes come from `OutboundFile.data` (already in-memory at delivery time,
   * sourced from the agent's outbox).
   */
  async function uploadImage(filename: string, data: Buffer): Promise<string> {
    const form = new FormData();
    form.append('image_type', 'message');
    // Construct a Blob from the buffer; the SDK side accepts either.
    form.append('image', new Blob([new Uint8Array(data)]), filename);

    const url = `${config.baseUrl}/open-apis/im/v1/images`;
    const token = await fetchTenantAccessToken();
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as FeishuApiResponse & { data?: { image_key?: string } }) : null;
    if (!parsed || parsed.code !== 0 || !parsed.data?.image_key) {
      throw new Error(`Feishu image upload failed: ${parsed?.msg || `code ${parsed?.code ?? response.status}`}`);
    }
    return parsed.data.image_key;
  }

  function isImageFile(filename: string): boolean {
    return /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(filename);
  }

  async function createMessage(
    target: FeishuReceiveTarget,
    msgType: 'text' | 'interactive' | 'image' | 'file',
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

    // Build span attributes (only include non-undefined values)
    const spanAttributes: Record<string, unknown> = {
      'channel.type': 'feishu',
    };
    if (event.message.chat_type !== undefined) {
      spanAttributes['feishu.chat_type'] = event.message.chat_type;
    }
    if (senderId !== undefined) {
      spanAttributes['feishu.sender_id'] = senderId;
    }
    // message.kind is always 'chat' for FeishuMessageEvent, but read from event for flexibility
    const messageKind = (event as { message?: { kind?: string } }).message?.kind ?? 'chat';
    spanAttributes['message.kind'] = messageKind;

    return runInDetachedRoot(() =>
      withSpan('channel.feishu.receive', chainAttrs(spanAttributes), async () => {
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
        if (!markInboundSeen('feishu', `msg:${event.message.message_id}`)) {
          inboundTotal.labels('feishu', 'deduped').inc();
          return;
        }

        const isGroup = event.message.chat_type === 'group';
        const text = parseTextContent(event.message.content, event.message.message_type);
        const isMention = isGroup ? mentionsBot(event, config) : true;

        // Roster-DM p2p opt-out (ADR-0023 item 11a). A DIRECT (p2p) message that
        // is a leave/opt-out command tears down the sender's own grant(s). The
        // participant_open_id is the inbound sender (trusted) — never the
        // payload — so a forged scopeId can at most revoke the SENDER's own
        // grant. Checked before opt-in so a "leave" can't be mistaken for a
        // re-consent. Only honored in p2p (not group context).
        if (!isGroup) {
          const rosterOptOut = parseRosterOptOut(parseJsonObject(text), text);
          if (rosterOptOut) {
            const senderOpenId = readString(event.sender.sender_id.open_id);
            if (senderOpenId) optOutParticipant(senderOpenId, rosterOptOut.scopeId);
            return;
          }
        }

        // Roster-DM p2p-ingress consent (ADR-0023). When a DIRECT (p2p) message
        // carries a roster opt-in command, capture consent from the open_id of
        // THIS event. A group-chat message records intent only (no grant, no
        // p2p channel minting) — enforced inside captureP2pIngressConsent.
        const rosterOptIn = parseRosterOptIn(parseJsonObject(text));
        if (rosterOptIn) {
          captureP2pIngressConsent({
            optIn: rosterOptIn,
            senderOpenId: readString(event.sender.sender_id.open_id),
            inboundMsgId: `msg:${event.message.message_id}`,
            isGroup,
            // p2p opt-in has no group to leave → null origin (item 11b). A
            // group-chat opt-in is rejected as intent-only inside the capture.
            originPlatformId: null,
          });
          return;
        }

        log.info('Feishu inbound message accepted', {
          messageId: event.message.message_id,
          chatId: event.message.chat_id,
          chatType: event.message.chat_type,
          senderId: senderId || null,
          isGroup,
          isMention,
        });
        const cfg = setupConfig!;
        await cfg.onInbound(platformId, resolveThreadId(event), {
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
      }),
    );
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
      // Roster-DM leave/disband revoke (ADR-0023 item 11b, best-effort).
      'im.chat.member.user.deleted_v1': async (data: unknown) => {
        handleChatMemberLeave(data, false);
      },
      'im.chat.disbanded_v1': async (data: unknown) => {
        handleChatMemberLeave(data, true);
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
    if (!token) return;
    if (!markInboundSeen('feishu', `action:${token}`)) {
      inboundTotal.labels('feishu', 'deduped').inc();
      return;
    }
    // Roster-DM directed "exit" card (ADR-0023 item 11a). A card whose action
    // value is a roster opt-out revokes the clicking operator's own grant,
    // fail-closed on operator identity (same member-scoped check as opt-in).
    // Terminal branch, checked before the opt-in card.
    const rosterOptOut = parseRosterOptOut(event.action.value);
    if (rosterOptOut) {
      const operatorOpenId = readString(event.operator.open_id);
      // expectedUserId on the opt-out card (if present) must match the operator,
      // same fail-closed rule as opt-in cards. Absent expectedUserId is allowed
      // for opt-out (it only ever revokes the OPERATOR's own grant — fail-safe
      // direction), but we still require a confirmed operator open_id.
      const expected = readString((event.action.value as Record<string, unknown>).expectedUserId);
      if (operatorOpenId && (!expected || cardActionOperatorAllowed(expected, operatorOpenId))) {
        optOutParticipant(operatorOpenId, rosterOptOut.scopeId);
      }
      return;
    }

    // Roster-DM directed-card consent (ADR-0023). A card whose action value is a
    // roster opt-in is captured here, fail-closed: the operator's open_id must
    // match the card's member-scoped expectedUserId (handled inside
    // captureDirectedCardConsent). This is a terminal branch — a roster card is
    // never also an ask_question card.
    const rosterOptIn = parseRosterOptIn(event.action.value);
    if (rosterOptIn) {
      const operatorOpenId = readString(event.operator.open_id);
      const cardChatId = readString(event.context.chat_id);
      captureDirectedCardConsent({
        optIn: rosterOptIn,
        operatorOpenId,
        inboundMsgId: `action:${token}`,
        // Record the chat the card was clicked in so a later leave/disband of
        // that chat can revoke this grant (item 11b).
        originPlatformId: cardChatId ? `feishu:${cardChatId}` : null,
      });
      return;
    }
    const action = parseFeishuQuestionActionPayload(event.action.value);
    if (!action) {
      // Distinguish an EXPIRED click from a genuinely-unsupported payload
      // (parse returns null for both). An expired click means the user clicked
      // a stale question/approval card — tell them so instead of silently
      // swallowing it and leaving them to think it worked. (roadmap 6.2)
      const cardChatId = readString(event.context.chat_id);
      if (isExpiredQuestionPayload(event.action.value) && cardChatId) {
        try {
          await createMessage(
            resolveReceiveTarget(cardChatId),
            'text',
            JSON.stringify({
              text: t('card.expired'),
            }),
            null,
          );
        } catch (err) {
          log.warn('Feishu: failed to notify user of expired card action', { token, err });
        }
        return;
      }
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
    if (!cardActionOperatorAllowed(action.expectedUserId, operatorUserId)) {
      // Fail closed: a card scoped to a specific user requires a confirmed,
      // matching operator. A missing/empty operatorUserId means we cannot
      // verify who acted, so we reject rather than let an unknown caller
      // answer another user's approval card.
      policyCheckFailedTotal.inc({
        policy: 'approval_operator_identity',
        reason: operatorUserId ? 'mismatch' : 'absent',
      });
      log.warn('Feishu card action rejected: operator identity unconfirmed or mismatched', {
        token,
        expectedUserId: action.expectedUserId,
        operatorUserId: operatorUserId || null,
      });
      return;
    }
    setupConfig.onAction(action.questionId, action.selectedOption, operatorUserId);
  }

  /**
   * Roster-DM platform leave/disband revoke (ADR-0023 item 11b, best-effort).
   *
   * `im.chat.member.user.deleted_v1` fires when one or more members are removed
   * from / leave a group; `im.chat.disbanded_v1` fires when a group is
   * dissolved. We revoke grants consented in that chat (origin_platform_id =
   * `feishu:<chat_id>`) for the leaving member(s) — or, on disband, for every
   * member whose grant originated there.
   *
   * This is BEST-EFFORT: events can be missed (host down, no subscription), so
   * it never replaces the send-time re-check (item 12) or scope teardown — it
   * just tightens the window. Guarded by table presence so installs without the
   * migration are unaffected.
   */
  function handleChatMemberLeave(eventData: unknown, disbanded: boolean): void {
    if (!hasTable(getDb(), 'dm_grants')) return;
    if (!isRecord(eventData)) return;
    const chatId = readString(eventData.chat_id);
    if (!chatId) return;
    const originPlatformId = `feishu:${chatId}`;
    if (disbanded) {
      const n = revokeGrantsForLeaver(originPlatformId, null);
      if (n > 0) log.info('roster-dm: revoked grants on chat disband', { originPlatformId, revoked: n });
      return;
    }
    // member.user.deleted carries the leaving users in `users[].user_id.open_id`.
    const users = Array.isArray(eventData.users) ? eventData.users : [];
    let total = 0;
    for (const u of users) {
      if (!isRecord(u)) continue;
      const userId = isRecord(u.user_id) ? readString(u.user_id.open_id) : undefined;
      if (!userId) continue;
      total += revokeGrantsForLeaver(originPlatformId, userId);
    }
    if (total > 0) log.info('roster-dm: revoked grants on member leave', { originPlatformId, revoked: total });
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
      } else if (eventType === 'im.chat.member.user.deleted_v1') {
        // Roster-DM leave revoke (ADR-0023 item 11b, best-effort).
        handleChatMemberLeave(eventData, false);
      } else if (eventType === 'im.chat.disbanded_v1') {
        handleChatMemberLeave(eventData, true);
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
        const title =
          typeof content.title === 'string' && content.title.trim() ? content.title.trim() : t('card.question.title');
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
        try {
          return await createMessage(target, 'interactive', JSON.stringify(card), threadId);
        } catch (err) {
          // The interactive card was rejected by Feishu (schema/size/API drift).
          // Don't let the question silently fail into the retry → permanent-
          // failure path: degrade to a plain-text question with numbered options
          // so the user can still respond by replying. (roadmap 6.4)
          log.warn('Feishu ask_question card send failed; falling back to plain text', {
            questionId: content.questionId,
            err,
          });
          const fallbackText = buildAskQuestionFallbackText({
            title,
            question,
            options,
            replyHint: t('card.replyHint'),
          });
          return createMessage(target, 'text', JSON.stringify({ text: fallbackText }), threadId);
        }
      }

      // Roster-DM directed opt-in card (ADR-0044 Stage 3). The HOST invite
      // handler stamped content.optIn (scopeId/slotLabel/agentGroupId/
      // expectedUserId/expiresAt); we only render it onto a clickable card whose
      // button value is that payload verbatim. The clicker's open_id must equal
      // the card's expectedUserId for a grant to mint (captureDirectedCardConsent,
      // fail-closed). NEVER build this card from container-supplied fields.
      if (content.type === 'roster_invite' && isRecord(content.optIn)) {
        const card = buildFeishuRosterOptInCard({
          slotLabel: readString(content.slotLabel) ?? 'contact',
          optIn: content.optIn,
          prompt: readString(content.prompt),
        });
        return createMessage(target, 'interactive', JSON.stringify(card), threadId);
      }

      if (content.type === 'card') {
        const card = buildDisplayCard(content);
        return createMessage(target, 'interactive', JSON.stringify(card), threadId);
      }

      // Split attached files: image extensions get uploaded + sent as
      // msg_type=image; everything else falls back to the legacy
      // "Attachments: <filename>" text suffix (still better than dropping).
      const files = message.files ?? [];
      const images = files.filter((f) => isImageFile(f.filename));
      const nonImages: typeof files = files.filter((f) => !isImageFile(f.filename));

      let firstId: string | undefined;
      for (const img of images) {
        try {
          const imageKey = await uploadImage(img.filename, img.data);
          const imgMsgId = await createMessage(
            target,
            'image',
            JSON.stringify({ image_key: imageKey }),
            firstId ? null : threadId,
          );
          if (!firstId) firstId = imgMsgId;
        } catch (err) {
          // Upload failed — degrade to filename suffix in the text branch.
          log.warn('Feishu image upload failed, falling back to filename in text', {
            filename: img.filename,
            err,
          });
          nonImages.push(img);
        }
      }

      const rawText =
        (typeof content.markdown === 'string' ? content.markdown : undefined) ||
        (typeof content.text === 'string' ? content.text : undefined) ||
        '';
      const text = appendAttachmentSummary(rawText, nonImages);
      if (!text.trim()) return firstId;

      const chunks = splitForLimit(text, DEFAULT_FEISHU_TEXT_LIMIT);
      for (let index = 0; index < chunks.length; index += 1) {
        const messageId = await createMessage(
          target,
          'text',
          JSON.stringify({ text: chunks[index] }),
          firstId ? null : index === 0 ? threadId : null,
        );
        if (!firstId) firstId = messageId;
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

    /**
     * Strong group-membership check for roster-DM send-time verification
     * (ADR-0023 item 12). `platformId` is the group key (`feishu:<chat_id>`);
     * `userHandle` is the participant open_id (`ou_*`). Pages the Feishu group
     * members API (member_id_type=open_id) and reports membership.
     *
     * Returns:
     *   - true / false  on a definite answer from the API.
     *   - undefined     when we can't determine it (not a group key, malformed
     *                   input, or an API/network error) — the gate then falls
     *                   back to the consent-revoke paths rather than dropping a
     *                   legitimate DM on a transient failure.
     */
    async isMember(platformId: string, userHandle: string): Promise<boolean | undefined> {
      const handle = userHandle.trim();
      if (!handle.startsWith('ou_')) return undefined; // only open_id members are checkable
      // Resolve the chat_id. The group key is `feishu:<oc_...>`; refuse p2p keys.
      const raw = platformId.startsWith('feishu:') ? platformId.slice('feishu:'.length) : platformId;
      if (raw.startsWith('p2p:') || !raw.startsWith('oc_')) return undefined;
      const chatId = raw;
      try {
        let pageToken: string | undefined;
        // Bounded paging — a handful of pages covers very large groups; bail to
        // "unknown" rather than loop unboundedly on a misbehaving API.
        for (let page = 0; page < 20; page++) {
          const res = await callApi<
            FeishuApiResponse & {
              data?: { items?: Array<{ member_id?: string }>; page_token?: string; has_more?: boolean };
            }
          >(`/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members`, {
            method: 'GET',
            query: { member_id_type: 'open_id', page_size: 100, page_token: pageToken },
          });
          if (res.code !== 0 && res.code !== undefined) return undefined; // API error → unknown
          const items = res.data?.items ?? [];
          if (items.some((m) => m.member_id === handle)) return true;
          if (!res.data?.has_more || !res.data.page_token) return false;
          pageToken = res.data.page_token;
        }
        return false; // exhausted the page budget without finding them
      } catch (err) {
        log.warn('Feishu isMember check failed — returning unknown', { chatId, err });
        return undefined;
      }
    },
  };

  return adapter;
}

const envConfig = readEnvConfig();
registerChannelAdapter('feishu', {
  factory: () => (envConfig ? createAdapter(envConfig) : null),
});

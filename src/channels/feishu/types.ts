/**
 * Shared Feishu type definitions. Kept free of runtime code so callers can
 * import types without pulling in the adapter + SDK.
 */
export type FeishuEventMode = 'webhook' | 'long-connection' | 'hybrid';

export interface FeishuConfig {
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

export interface FeishuTenantTokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

export interface FeishuApiResponse {
  code?: number;
  msg?: string;
  data?: Record<string, unknown>;
}

export interface FeishuReactionOperator {
  operator_type?: 'app' | 'user';
}

export interface FeishuReactionItem {
  reaction_id?: string;
  operator?: FeishuReactionOperator;
  reaction_type?: {
    emoji_type?: string;
  };
}

export interface FeishuMessageEvent {
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

export interface FeishuCardActionEvent {
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

export interface FeishuReceiveTarget {
  receiveId: string;
  receiveIdType: 'chat_id' | 'open_id' | 'user_id';
}

export interface FeishuQuestionActionPayload {
  kind: 'card.ask_question';
  questionId: string;
  selectedOption: string;
  selectedLabel?: string;
  expectedUserId?: string;
  expiresAt?: number;
}

export interface NormalizedQuestionOption {
  label: string;
  value: string;
  selectedLabel: string;
}

export interface TokenCacheEntry {
  token: string;
  expiresAt: number;
}

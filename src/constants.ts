export const PLUGIN_ID = "line-bridge";
export const PLUGIN_VERSION = "0.1.0";

export const PRINCIPAL_STATUSES = {
  pending: "pending",
  active: "active",
  suspended: "suspended",
} as const;

export const LINE_API = {
  replyUrl: "https://api.line.me/v2/bot/message/reply",
  pushUrl: "https://api.line.me/v2/bot/message/push",
  profileBaseUrl: "https://api.line.me/v2/bot/profile",
  contentBaseUrl: "https://api-data.line.me/v2/bot/message",
} as const;

export const PRINCIPAL_STATE_KEY_PREFIX = "principal:";
export const WEBHOOK_NAMESPACE = "webhooks";

export const WEBHOOK_KEYS = {
  lineWebhook: "line-webhook",
} as const;

export const JOB_KEYS = {
  processEvent: "process-event",
  idleClose: "idle-close",
  replyTokenGc: "reply-token-gc",
} as const;

export const STATE_NAMESPACES = {
  events: "events",
  operations: "operations",
  pushLimits: "push-limits",
  replyTokens: "reply-tokens",
  sessions: "sessions",
  threads: "threads",
  webhooks: WEBHOOK_NAMESPACE,
} as const;

export const STATE_KEYS = {
  commentMetaIndex: "comment-meta-index",
  operations: "operations",
  pendingEventKeys: "pending-event-keys",
  pushCounterIndex: "push-counter-index",
  threadIndex: "thread-index",
} as const;

export const ATTACHMENT_OBJECT_PREFIX = "line-bridge";
export const ATTACHMENT_LIFECYCLE_DAYS = 90;

export const TOOL_NAMES = {
  pushText: "line.push_text",
  pushImage: "line.push_image",
  pushFlex: "line.push_flex",
  pushTemplate: "line.push_template",
  pushSticker: "line.push_sticker",
  ackWithReplyToken: "line.ack_with_reply_token",
  closeThread: "line.close_thread",
  getProfile: "line.get_profile",
} as const;

export const DEFAULT_CONFIG = {
  lineChannelSecretRef: "",
  lineChannelAccessTokenRef: "",
  paperclipBoardApiKeyRef: "",
  paperclipApiBaseUrl: "",
  defaultPaperclipCompany: "",
  defaultAgentId: "",
  attachmentBucketName: "",
  attachmentSignedUrlTtlDays: 30,
  idleCloseMinutes: 30,
  linePushDailyLimit: 500,
  replyTokenMaxAgeSeconds: 60,
} as const;

export type LineBridgeConfig = {
  lineChannelSecretRef: string;
  lineChannelAccessTokenRef: string;
  paperclipBoardApiKeyRef: string;
  paperclipApiBaseUrl: string;
  defaultPaperclipCompany: string;
  defaultAgentId: string;
  attachmentBucketName: string;
  attachmentSignedUrlTtlDays: number;
  idleCloseMinutes: number;
  linePushDailyLimit: number;
  replyTokenMaxAgeSeconds: number;
};

type BasePrincipalState = {
  version: number;
  lineUserId: string;
  displayName: string | null;
  pictureUrl: string | null;
  status: (typeof PRINCIPAL_STATUSES)[keyof typeof PRINCIPAL_STATUSES];
  linkedAt: string | null;
  paperclipCompany: string | null;
  agentId: string | null;
  preferredLocale?: string | null;
  /**
   * Plugin-private metadata attached by an `onProvisionPrincipal` extension
   * hook. The plugin does not interpret this; it round-trips it intact.
   */
  metadata?: Record<string, string>;
};

export type PendingPrincipalState = BasePrincipalState & {
  status: typeof PRINCIPAL_STATUSES.pending;
};

export type ActivePrincipalState = BasePrincipalState & {
  status: typeof PRINCIPAL_STATUSES.active;
  linkedAt: string;
  paperclipCompany: string;
  agentId: string;
};

export type SuspendedPrincipalState = BasePrincipalState & {
  status: typeof PRINCIPAL_STATUSES.suspended;
};

export type PrincipalState =
  | PendingPrincipalState
  | ActivePrincipalState
  | SuspendedPrincipalState;

export type ThreadSessionState = {
  issueId: string;
  lineUserId: string;
  sessionId: string;
  agentId: string;
  status: "open" | "closed";
  openedAt: string;
  lastActivityAt: string;
  lastCommentId?: string;
  closedAt?: string;
  closeReason?: string;
};

export type CommentMetaState = {
  version: number;
  lineUserId: string;
  lineMessageId: string | null;
  replyToken: string;
  capturedAt: string;
  usedAt?: string | null;
};

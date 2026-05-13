import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  definePlugin,
  runWorker,
  type AgentSessionEvent,
  type PluginContext,
  type PluginHealthDiagnostics,
  type PluginWebhookInput,
  type ToolRunContext,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  ATTACHMENT_LIFECYCLE_DAYS,
  ATTACHMENT_OBJECT_PREFIX,
  type CommentMetaState,
  DEFAULT_CONFIG,
  JOB_KEYS,
  LINE_API,
  PRINCIPAL_STATE_KEY_PREFIX,
  PRINCIPAL_STATUSES,
  STATE_KEYS,
  STATE_NAMESPACES,
  TOOL_NAMES,
  WEBHOOK_KEYS,
  type LineBridgeConfig,
  type PrincipalState,
} from "./constants.js";
import type { LineBridgeExtensions, ProvisionPrincipalContext } from "./extensions.js";
import { withLock } from "./lock.js";
import manifest from "./manifest.js";
import {
  closeThreadSession,
  deliverLineTurnToSession,
  type SessionMode,
} from "./session-registry.js";
import {
  registerAcpOutputListener,
  setAcpRelayHandler,
} from "./acp-bridge.js";

const PENDING_KEYS_LOCK = "pending-keys";
const LINE_OPS_LOCK = "line-operations";
const LINE_OPS_DATA_KEY = "line-ops";
const MAX_LINE_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const WEBHOOK_AUTH_ERROR_CODE = 401;

let currentContext: PluginContext | null = null;
let nearRealtimeDrainTimer: ReturnType<typeof setTimeout> | null = null;
let nearRealtimeDrainRunning = false;
let nearRealtimeDrainRequested = false;
const sessionStreamingPushKeys = new Set<string>();

let registeredExtensions: LineBridgeExtensions = {};

/**
 * Register downstream extension hooks for this plugin instance. Call this
 * before `runWorker` starts (for example from a fork's bootstrap module) to
 * attach an `onProvisionPrincipal` hook that maps inbound LINE userIds to
 * Paperclip companies and agents in your own identity model. See
 * {@link LineBridgeExtensions} for the full contract.
 *
 * Called with no extensions, the plugin runs in single-tenant mode using the
 * `defaultPaperclipCompany` and `defaultAgentId` instance config values.
 */
export function setExtensions(extensions: LineBridgeExtensions): void {
  registeredExtensions = { ...extensions };
}

/**
 * Returns the currently registered extension hooks. Mainly useful for tests.
 */
export function getExtensions(): LineBridgeExtensions {
  return registeredExtensions;
}

type LineEventSource = {
  type?: string;
  userId?: string;
};

type LineEventMessage = {
  type?: string;
  id?: string;
  text?: string;
  fileName?: string;
};

type LineWebhookEvent = {
  type?: string;
  timestamp?: number;
  webhookEventId?: string;
  replyToken?: string;
  deliveryContext?: {
    isRedelivery?: boolean;
  };
  source?: LineEventSource;
  message?: LineEventMessage;
};

type LineWebhookBody = {
  events?: LineWebhookEvent[];
};

class WebhookAuthenticationError extends Error {
  readonly code = WEBHOOK_AUTH_ERROR_CODE;
}

type ResolvedActivePrincipal = {
  paperclipCompany: string;
  displayName?: string | null;
  status: "active";
  linkedAt?: string;
  agentId?: string | null;
  preferredLocale?: string | null;
};

type LineThreadState = {
  paperclipIssueId: string;
  status: "open" | "closed";
  lastActivityAt: string;
  lastCommentId?: string;
};

type QueuedLineEvent = {
  dedupKey: string;
  event: LineWebhookEvent;
  lineUserId: string;
  queuedAt: string;
  requestId: string;
  deliveryContext?: {
    companyId: string;
    issueId: string;
    commentId?: string;
    agentId: string;
    occurredAt: string;
    threadOutcome: "created_thread" | "reused_thread";
  };
};

type ProcessedLineEvent = {
  dedupKey: string;
  processedAt: string;
  outcome: "processed" | "skipped";
  requestId: string;
  lineUserId: string;
  issueId?: string;
  commentId?: string;
  reason?: string;
};

type ReplyTokenIndexEntry = {
  companyId: string;
  commentId: string;
};

type ThreadIndexEntry = {
  companyId: string;
  lineUserId: string;
};

type DrainQueuedLineEventsOptions = {
  trigger: "schedule" | "manual" | "retry" | "webhook";
  runId?: string;
};

type SupportedAttachmentMessageType = "image" | "video" | "audio" | "file";

type RelayAttachmentResult =
  | {
      ok: true;
      attachmentId: string | null;
      url: string;
      filename: string;
      contentType: string;
      byteSize: number;
      objectKey: string;
      bucketName: string;
      expiresAt: string;
      lifecycleDays: number;
    }
  | {
      ok: false;
      reason: string;
    };

type PushCounterIndexEntry = {
  dateKey: string;
  companyId: string;
  agentId: string;
  stateKey: string;
};

type PushCounterState = PushCounterIndexEntry & {
  version: number;
  count: number;
  limit: number;
  resetAt: string;
  updatedAt: string;
};

type LineOpsLastWebhook = {
  endpointKey: string;
  requestId: string;
  eventCount: number;
  queuedCount: number;
  receivedAt: string;
};

type LineOpsLastQueueDrain = {
  trigger: DrainQueuedLineEventsOptions["trigger"];
  runId?: string;
  pendingCount: number;
  failures: number;
  completedAt: string;
};

type LineOpsState = {
  version: number;
  updatedAt: string;
  webhookDeliveries: number;
  webhookDeliveryFailures: number;
  webhookEventsQueued: number;
  webhookDroppedUnmapped: number;
  queueDrainRuns: number;
  queueDrainFailures: number;
  attachmentRelaySucceeded: number;
  attachmentRelayFailed: number;
  linePushAttempted: number;
  linePushSucceeded: number;
  linePushFailed: number;
  linePushRejected: number;
  replyTokenMisses: number;
  idleThreadsClosed: number;
  idleThreadsPruned: number;
  acpSpawned: number;
  acpMessages: number;
  acpClosed: number;
  acpOutputRelayed: number;
  acpOutputDropped: number;
  lastWebhook?: LineOpsLastWebhook;
  lastQueueDrain?: LineOpsLastQueueDrain;
  lastPushLimitRejection?: {
    companyId: string;
    agentId: string;
    lineUserId: string;
    messageType: string;
    dateKey: string;
    limit: number;
    rejectedAt: string;
  };
};

type LineAttachmentContent = {
  body: Buffer;
  filename: string;
  contentType: string;
  byteSize: number;
};

function getDeclaredWebhookKeys(): string[] {
  return (manifest.webhooks ?? []).map((webhook) => webhook.endpointKey);
}

function getDeclaredJobKeys(): string[] {
  return (manifest.jobs ?? []).map((job) => job.jobKey);
}

function getDeclaredToolNames(): string[] {
  return (manifest.tools ?? []).map((tool) => tool.name);
}

function sanitizeObjectKeySegment(value: string): string {
  const cleaned = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 120) : "unknown";
}

async function getConfig(ctx: PluginContext): Promise<LineBridgeConfig> {
  const raw = await ctx.config.get();
  return {
    ...DEFAULT_CONFIG,
    ...raw,
  } as LineBridgeConfig;
}

function getPrincipalStateKey(lineUserId: string): string {
  return `${PRINCIPAL_STATE_KEY_PREFIX}${lineUserId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function normalizePreferredLocale(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getHeader(headers: Record<string, string | string[]>, key: string): string | null {
  const direct = headers[key];
  if (typeof direct === "string") return direct;
  if (Array.isArray(direct)) return direct[0] ?? null;

  const matched = Object.keys(headers).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  if (!matched) return null;
  const value = headers[matched];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function webhookAuthenticationError(message: string): WebhookAuthenticationError {
  return new WebhookAuthenticationError(message);
}

function timingSafeStringEquals(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function createLineWebhookSignature(rawBody: string, channelSecret: string): string {
  return createHmac("sha256", channelSecret).update(rawBody).digest("base64");
}

async function verifyLineWebhookSignature(
  ctx: PluginContext,
  config: LineBridgeConfig,
  input: PluginWebhookInput,
): Promise<void> {
  if (!config.lineChannelSecretRef) {
    throw webhookAuthenticationError("LINE webhook rejected: lineChannelSecretRef is not configured");
  }
  const signature = getHeader(input.headers, "x-line-signature");
  if (!signature) {
    throw webhookAuthenticationError("Invalid LINE webhook signature");
  }
  const channelSecret = await ctx.secrets.resolve(config.lineChannelSecretRef);
  if (!channelSecret) {
    throw webhookAuthenticationError("LINE webhook rejected: channel secret did not resolve");
  }
  const expected = createLineWebhookSignature(input.rawBody, channelSecret);
  if (!timingSafeStringEquals(signature, expected)) {
    throw webhookAuthenticationError("Invalid LINE webhook signature");
  }
}

async function getPrincipalState(ctx: PluginContext, lineUserId: string): Promise<PrincipalState | null> {
  const value = await ctx.state.get({
    scopeKind: "instance",
    stateKey: getPrincipalStateKey(lineUserId),
  });
  return (value ?? null) as PrincipalState | null;
}

async function setPrincipalState(ctx: PluginContext, lineUserId: string, value: PrincipalState): Promise<void> {
  await ctx.state.set(
    {
      scopeKind: "instance",
      stateKey: getPrincipalStateKey(lineUserId),
    },
    value,
  );
}

function instanceState(stateKey: string, namespace?: string) {
  return { scopeKind: "instance" as const, namespace, stateKey };
}

function companyState(companyId: string, stateKey: string, namespace?: string) {
  return { scopeKind: "company" as const, scopeId: companyId, namespace, stateKey };
}

function createEmptyLineOpsState(now = new Date().toISOString()): LineOpsState {
  return {
    version: 1,
    updatedAt: now,
    webhookDeliveries: 0,
    webhookDeliveryFailures: 0,
    webhookEventsQueued: 0,
    webhookDroppedUnmapped: 0,
    queueDrainRuns: 0,
    queueDrainFailures: 0,
    attachmentRelaySucceeded: 0,
    attachmentRelayFailed: 0,
    linePushAttempted: 0,
    linePushSucceeded: 0,
    linePushFailed: 0,
    linePushRejected: 0,
    replyTokenMisses: 0,
    idleThreadsClosed: 0,
    idleThreadsPruned: 0,
    acpSpawned: 0,
    acpMessages: 0,
    acpClosed: 0,
    acpOutputRelayed: 0,
    acpOutputDropped: 0,
  };
}

function readNumber(record: Record<string, unknown>, key: keyof LineOpsState): number {
  const value = record[key as string];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseLineOpsState(raw: unknown): LineOpsState {
  const record = asRecord(raw);
  if (!record) return createEmptyLineOpsState();

  const state = createEmptyLineOpsState(typeof record.updatedAt === "string" ? record.updatedAt : undefined);
  state.version = typeof record.version === "number" ? record.version : 1;
  state.webhookDeliveries = readNumber(record, "webhookDeliveries");
  state.webhookDeliveryFailures = readNumber(record, "webhookDeliveryFailures");
  state.webhookEventsQueued = readNumber(record, "webhookEventsQueued");
  state.webhookDroppedUnmapped = readNumber(record, "webhookDroppedUnmapped");
  state.queueDrainRuns = readNumber(record, "queueDrainRuns");
  state.queueDrainFailures = readNumber(record, "queueDrainFailures");
  state.attachmentRelaySucceeded = readNumber(record, "attachmentRelaySucceeded");
  state.attachmentRelayFailed = readNumber(record, "attachmentRelayFailed");
  state.linePushAttempted = readNumber(record, "linePushAttempted");
  state.linePushSucceeded = readNumber(record, "linePushSucceeded");
  state.linePushFailed = readNumber(record, "linePushFailed");
  state.linePushRejected = readNumber(record, "linePushRejected");
  state.replyTokenMisses = readNumber(record, "replyTokenMisses");
  state.idleThreadsClosed = readNumber(record, "idleThreadsClosed");
  state.idleThreadsPruned = readNumber(record, "idleThreadsPruned");
  state.acpSpawned = readNumber(record, "acpSpawned");
  state.acpMessages = readNumber(record, "acpMessages");
  state.acpClosed = readNumber(record, "acpClosed");
  state.acpOutputRelayed = readNumber(record, "acpOutputRelayed");
  state.acpOutputDropped = readNumber(record, "acpOutputDropped");
  state.lastWebhook = asRecord(record.lastWebhook) as LineOpsLastWebhook | undefined;
  state.lastQueueDrain = asRecord(record.lastQueueDrain) as LineOpsLastQueueDrain | undefined;
  state.lastPushLimitRejection = asRecord(record.lastPushLimitRejection) as LineOpsState["lastPushLimitRejection"];
  return state;
}

async function getLineOpsState(ctx: PluginContext): Promise<LineOpsState> {
  const raw = await ctx.state.get(instanceState(STATE_KEYS.operations, STATE_NAMESPACES.operations));
  return parseLineOpsState(raw);
}

async function updateLineOpsState(
  ctx: PluginContext,
  updater: (state: LineOpsState, now: string) => void,
): Promise<LineOpsState> {
  return await withLock(LINE_OPS_LOCK, async () => {
    const now = new Date().toISOString();
    const state = await getLineOpsState(ctx);
    updater(state, now);
    state.updatedAt = now;
    await ctx.state.set(instanceState(STATE_KEYS.operations, STATE_NAMESPACES.operations), state);
    return state;
  });
}

async function tryUpdateLineOpsState(
  ctx: PluginContext,
  updater: (state: LineOpsState, now: string) => void,
): Promise<void> {
  try {
    await updateLineOpsState(ctx, updater);
  } catch (error) {
    ctx.logger.warn("Failed to persist LINE ops state", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function writeMetric(
  ctx: PluginContext,
  name: string,
  value = 1,
  tags?: Record<string, string>,
): Promise<void> {
  try {
    await ctx.metrics.write(name, value, tags);
  } catch (error) {
    ctx.logger.warn("Failed to write LINE bridge metric", {
      metric: name,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function getUtcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function getResetAtForUtcDate(dateKey: string): string {
  return new Date(`${dateKey}T00:00:00.000Z`).getTime() >= 0
    ? new Date(Date.parse(`${dateKey}T00:00:00.000Z`) + 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

function pushCounterStateKey(dateKey: string, companyId: string, agentId: string): string {
  return `push-counter:${dateKey}:${companyId}:${agentId}`;
}

function isRetainedPushCounterIndexEntry(entry: PushCounterIndexEntry, today = getUtcDateKey()): boolean {
  return entry.dateKey >= today;
}

async function getPushCounterIndex(ctx: PluginContext): Promise<PushCounterIndexEntry[]> {
  const raw = await ctx.state.get(instanceState(STATE_KEYS.pushCounterIndex, STATE_NAMESPACES.pushLimits));
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is PushCounterIndexEntry => {
    const record = asRecord(entry);
    return (
      typeof record?.dateKey === "string" &&
      typeof record.companyId === "string" &&
      typeof record.agentId === "string" &&
      typeof record.stateKey === "string"
    );
  });
}

async function setPushCounterIndex(ctx: PluginContext, entries: PushCounterIndexEntry[]): Promise<void> {
  await ctx.state.set(instanceState(STATE_KEYS.pushCounterIndex, STATE_NAMESPACES.pushLimits), entries);
}

async function rememberPushCounterIndexEntry(ctx: PluginContext, entry: PushCounterIndexEntry): Promise<void> {
  await withLock(STATE_KEYS.pushCounterIndex, async () => {
    const currentEntries = await getPushCounterIndex(ctx);
    const entries = currentEntries.filter((candidate) => isRetainedPushCounterIndexEntry(candidate));
    const staleEntries = currentEntries.filter((candidate) => !isRetainedPushCounterIndexEntry(candidate));
    for (const staleEntry of staleEntries) {
      try {
        await ctx.state.delete(instanceState(staleEntry.stateKey, STATE_NAMESPACES.pushLimits));
      } catch (error) {
        ctx.logger.warn("Failed to delete stale LINE push counter state", {
          stateKey: staleEntry.stateKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!entries.some((candidate) => candidate.stateKey === entry.stateKey)) {
      entries.push(entry);
    }
    await setPushCounterIndex(ctx, entries);
  });
}

function parsePushCounterState(
  raw: unknown,
  fallback: PushCounterIndexEntry,
  limit: number,
): PushCounterState {
  const record = asRecord(raw);
  return {
    ...fallback,
    version: 1,
    count: typeof record?.count === "number" && Number.isFinite(record.count) ? record.count : 0,
    limit: typeof record?.limit === "number" && Number.isFinite(record.limit) ? record.limit : limit,
    resetAt: typeof record?.resetAt === "string" ? record.resetAt : getResetAtForUtcDate(fallback.dateKey),
    updatedAt: typeof record?.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
  };
}

async function getPushCounter(ctx: PluginContext, entry: PushCounterIndexEntry, limit: number): Promise<PushCounterState> {
  const raw = await ctx.state.get(instanceState(entry.stateKey, STATE_NAMESPACES.pushLimits));
  return parsePushCounterState(raw, entry, limit);
}

async function getPushCounterSnapshot(ctx: PluginContext): Promise<PushCounterState[]> {
  const entries = await getPushCounterIndex(ctx);
  const today = getUtcDateKey();
  return await Promise.all(
    entries
      .filter((candidate) => candidate.dateKey === today)
      .map((entry) => getPushCounter(ctx, entry, DEFAULT_CONFIG.linePushDailyLimit)),
  );
}

async function getLineOpsSnapshot(ctx: PluginContext): Promise<Record<string, unknown>> {
  const [state, pendingQueueCount, pushCounters] = await Promise.all([
    getLineOpsState(ctx),
    getPendingEventKeys(ctx).then((keys) => keys.length),
    getPushCounterSnapshot(ctx),
  ]);
  return {
    ...state,
    pendingQueueCount,
    pushCounters,
  };
}

function threadStateKey(lineUserId: string): string {
  return `thread:${lineUserId}`;
}

function threadLockKey(companyId: string, lineUserId: string): string {
  return `thread-lock:${companyId}:${lineUserId}`;
}

function principalLockKey(lineUserId: string): string {
  return `principal-lock:${lineUserId}`;
}

function queuedEventStateKey(dedupKey: string): string {
  return `queued:${dedupKey}`;
}

function processedEventStateKey(dedupKey: string): string {
  return `processed:${dedupKey}`;
}

function commentMetaStateKey(commentId: string): string {
  return `comment-meta:${commentId}`;
}

function isSupportedAttachmentMessageType(value: string | undefined): value is SupportedAttachmentMessageType {
  return value === "image" || value === "video" || value === "audio" || value === "file";
}

function sanitizeFilename(value: string): string {
  return value
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/-+/g, "-")
    .replaceAll(/^-|-$/g, "")
    .slice(0, 120);
}

function getContentTypeExtension(contentType: string): string | null {
  const normalized = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  const known = new Map<string, string>([
    ["image/jpeg", "jpg"],
    ["image/png", "png"],
    ["image/gif", "gif"],
    ["image/webp", "webp"],
    ["video/mp4", "mp4"],
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/aac", "aac"],
    ["audio/wav", "wav"],
    ["application/pdf", "pdf"],
    ["application/zip", "zip"],
    ["text/plain", "txt"],
  ]);
  const direct = known.get(normalized);
  if (direct) return direct;
  const subtype = normalized.split("/")[1]?.trim();
  if (!subtype) return null;
  return sanitizeFilename(subtype);
}

function buildAttachmentFilename(input: {
  messageType: SupportedAttachmentMessageType;
  messageId: string;
  contentType: string;
  preferredFilename?: string | null;
}): string {
  const preferred = input.preferredFilename?.trim();
  if (preferred) {
    const sanitized = sanitizeFilename(preferred);
    if (sanitized) return sanitized;
  }

  const extension = getContentTypeExtension(input.contentType);
  const base = sanitizeFilename(`line-${input.messageType}-${input.messageId}`) || `line-${input.messageType}`;
  return extension ? `${base}.${extension}` : base;
}

function resolvePaperclipApiBaseUrl(config: LineBridgeConfig): string | null {
  const explicit = config.paperclipApiBaseUrl.trim();
  if (explicit) return trimTrailingSlash(explicit);
  const envValue = process.env.PAPERCLIP_API_URL?.trim();
  return envValue ? trimTrailingSlash(envValue) : null;
}

function buildEventDedupKey(event: LineWebhookEvent): string {
  if (typeof event.webhookEventId === "string" && event.webhookEventId.trim().length > 0) {
    return `webhook:${event.webhookEventId}`;
  }
  if (event.type === "message" && typeof event.message?.id === "string" && event.message.id.trim().length > 0) {
    return `message:${event.message.id}`;
  }
  if (
    typeof event.source?.userId === "string" &&
    typeof event.type === "string" &&
    typeof event.timestamp === "number"
  ) {
    return `event:${event.source.userId}:${event.type}:${event.timestamp}`;
  }
  const fingerprint = createHash("sha256").update(JSON.stringify(event)).digest("hex");
  return `hash:${fingerprint}`;
}

async function getPendingEventKeys(ctx: PluginContext): Promise<string[]> {
  const raw = await ctx.state.get(instanceState(STATE_KEYS.pendingEventKeys, STATE_NAMESPACES.events));
  return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
}

async function setPendingEventKeys(ctx: PluginContext, keys: string[]): Promise<void> {
  await ctx.state.set(instanceState(STATE_KEYS.pendingEventKeys, STATE_NAMESPACES.events), keys);
}

async function removePendingEventKey(ctx: PluginContext, dedupKey: string): Promise<void> {
  await withLock(PENDING_KEYS_LOCK, async () => {
    const keys = await getPendingEventKeys(ctx);
    if (!keys.includes(dedupKey)) return;
    await setPendingEventKeys(
      ctx,
      keys.filter((value) => value !== dedupKey),
    );
  });
}

async function getReplyTokenIndex(ctx: PluginContext): Promise<ReplyTokenIndexEntry[]> {
  const raw = await ctx.state.get(instanceState(STATE_KEYS.commentMetaIndex, STATE_NAMESPACES.replyTokens));
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ReplyTokenIndexEntry => {
    const record = asRecord(entry);
    return typeof record?.companyId === "string" && typeof record?.commentId === "string";
  });
}

async function getThreadIndex(ctx: PluginContext): Promise<ThreadIndexEntry[]> {
  const raw = await ctx.state.get(instanceState(STATE_KEYS.threadIndex, STATE_NAMESPACES.threads));
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is ThreadIndexEntry => {
    const record = asRecord(entry);
    return typeof record?.companyId === "string" && typeof record?.lineUserId === "string";
  });
}

async function setThreadIndex(ctx: PluginContext, entries: ThreadIndexEntry[]): Promise<void> {
  await ctx.state.set(instanceState(STATE_KEYS.threadIndex, STATE_NAMESPACES.threads), entries);
}

async function setReplyTokenIndex(ctx: PluginContext, entries: ReplyTokenIndexEntry[]): Promise<void> {
  await ctx.state.set(instanceState(STATE_KEYS.commentMetaIndex, STATE_NAMESPACES.replyTokens), entries);
}

async function rememberCommentMeta(
  ctx: PluginContext,
  companyId: string,
  commentId: string,
  meta: CommentMetaState,
): Promise<void> {
  await ctx.state.set(
    companyState(companyId, commentMetaStateKey(commentId), STATE_NAMESPACES.replyTokens),
    meta,
  );
  await withLock(STATE_KEYS.commentMetaIndex, async () => {
    const entries = await getReplyTokenIndex(ctx);
    if (!entries.some((entry) => entry.companyId === companyId && entry.commentId === commentId)) {
      entries.push({ companyId, commentId });
      await setReplyTokenIndex(ctx, entries);
    }
  });
}

async function rememberReplyTokenForComment(
  ctx: PluginContext,
  input: {
    companyId: string;
    commentId: string;
    lineUserId: string;
    event: LineWebhookEvent;
    capturedAt: string;
  },
): Promise<void> {
  if (typeof input.event.replyToken !== "string" || input.event.replyToken.length === 0) {
    return;
  }

  const existing = await getCommentMeta(ctx, input.companyId, input.commentId);
  if (existing) return;

  await rememberCommentMeta(ctx, input.companyId, input.commentId, {
    version: 1,
    lineUserId: input.lineUserId,
    lineMessageId: typeof input.event.message?.id === "string" ? input.event.message.id : null,
    replyToken: input.event.replyToken,
    capturedAt: input.capturedAt,
    usedAt: null,
  });
}

async function getCommentMeta(
  ctx: PluginContext,
  companyId: string,
  commentId: string,
): Promise<CommentMetaState | null> {
  const raw = await ctx.state.get(
    companyState(companyId, commentMetaStateKey(commentId), STATE_NAMESPACES.replyTokens),
  );
  const record = asRecord(raw);
  if (
    !record ||
    typeof record.lineUserId !== "string" ||
    typeof record.replyToken !== "string" ||
    typeof record.capturedAt !== "string"
  ) {
    return null;
  }
  return {
    version: typeof record.version === "number" ? record.version : 1,
    lineUserId: record.lineUserId,
    lineMessageId: typeof record.lineMessageId === "string" ? record.lineMessageId : null,
    replyToken: record.replyToken,
    capturedAt: record.capturedAt,
    usedAt: typeof record.usedAt === "string" || record.usedAt === null ? record.usedAt : undefined,
  };
}

async function forgetCommentMeta(ctx: PluginContext, companyId: string, commentId: string): Promise<void> {
  await ctx.state.delete(
    companyState(companyId, commentMetaStateKey(commentId), STATE_NAMESPACES.replyTokens),
  );
  await withLock(STATE_KEYS.commentMetaIndex, async () => {
    const entries = await getReplyTokenIndex(ctx);
    await setReplyTokenIndex(
      ctx,
      entries.filter((entry) => !(entry.companyId === companyId && entry.commentId === commentId)),
    );
  });
}

async function queueWebhookEvent(ctx: PluginContext, queuedEvent: QueuedLineEvent): Promise<boolean> {
  return withLock(queuedEventStateKey(queuedEvent.dedupKey), async () => {
    const processed = await ctx.state.get(
      instanceState(processedEventStateKey(queuedEvent.dedupKey), STATE_NAMESPACES.events),
    );
    if (processed) return false;

    const queued = await ctx.state.get(
      instanceState(queuedEventStateKey(queuedEvent.dedupKey), STATE_NAMESPACES.events),
    );
    if (queued) return false;

    await ctx.state.set(
      instanceState(queuedEventStateKey(queuedEvent.dedupKey), STATE_NAMESPACES.events),
      queuedEvent,
    );

    await withLock(PENDING_KEYS_LOCK, async () => {
      const keys = await getPendingEventKeys(ctx);
      if (!keys.includes(queuedEvent.dedupKey)) {
        keys.push(queuedEvent.dedupKey);
        await setPendingEventKeys(ctx, keys);
      }
    });

    return true;
  });
}

async function setQueuedEventWithOptions(
  ctx: PluginContext,
  queuedEvent: QueuedLineEvent,
  options?: { lockHeld?: boolean },
): Promise<void> {
  const persist = async () => {
    const processed = await ctx.state.get(
      instanceState(processedEventStateKey(queuedEvent.dedupKey), STATE_NAMESPACES.events),
    );
    if (processed) return;

    await ctx.state.set(
      instanceState(queuedEventStateKey(queuedEvent.dedupKey), STATE_NAMESPACES.events),
      queuedEvent,
    );
  };

  if (options?.lockHeld) {
    await persist();
    return;
  }

  await withLock(queuedEventStateKey(queuedEvent.dedupKey), persist);
}

async function markEventProcessedWithOptions(
  ctx: PluginContext,
  result: ProcessedLineEvent,
  options?: { lockHeld?: boolean },
): Promise<void> {
  const finalize = async () => {
    const processedState = instanceState(processedEventStateKey(result.dedupKey), STATE_NAMESPACES.events);
    const queuedState = instanceState(queuedEventStateKey(result.dedupKey), STATE_NAMESPACES.events);
    const processed = await ctx.state.get(processedState);
    if (processed) {
      await ctx.state.delete(queuedState);
      return;
    }

    const queued = await ctx.state.get(queuedState);
    if (!queued) return;

    await ctx.state.set(processedState, result);
    await ctx.state.delete(queuedState);
  };

  if (options?.lockHeld) {
    await finalize();
  } else {
    await withLock(queuedEventStateKey(result.dedupKey), finalize);
  }

  await removePendingEventKey(ctx, result.dedupKey);
}

function toResolvedActivePrincipal(value: unknown): ResolvedActivePrincipal | null {
  const record = asRecord(value);
  if (!record) return null;
  const status = typeof record.status === "string" ? record.status : null;
  if (status !== PRINCIPAL_STATUSES.active) return null;
  const paperclipCompany = typeof record.paperclipCompany === "string" ? record.paperclipCompany : null;
  if (!paperclipCompany) return null;
  return {
    paperclipCompany,
    displayName: typeof record.displayName === "string" ? record.displayName : null,
    status: "active",
    linkedAt: typeof record.linkedAt === "string" ? record.linkedAt : undefined,
    agentId:
      typeof record.agentId === "string" || record.agentId === null
        ? (record.agentId as string | null)
        : undefined,
    preferredLocale: normalizePreferredLocale(record.preferredLocale),
  };
}

type DeliveryTarget =
  | { kind: "native"; agentId: string }
  | { kind: "native_unavailable"; agentId: string; status: string }
  | { kind: "acp"; agentId: string }
  | { kind: "none" };

async function resolveDeliveryTarget(
  ctx: PluginContext,
  principal: ResolvedActivePrincipal,
  preferredAgentId?: string | null,
): Promise<DeliveryTarget> {
  const candidate = (preferredAgentId ?? principal.agentId ?? "").trim();
  if (!candidate) return { kind: "none" };

  const agents = await ctx.agents.list({ companyId: principal.paperclipCompany });
  const matching = agents.find((agent) => (agent as { id?: unknown }).id === candidate);
  if (!matching) return { kind: "acp", agentId: candidate };

  const status = String((matching as { status?: unknown }).status ?? "").toLowerCase();
  if (!["active", "idle", "running"].includes(status)) {
    return { kind: "native_unavailable", agentId: candidate, status };
  }

  return { kind: "native", agentId: candidate };
}

async function getThreadState(
  ctx: PluginContext,
  companyId: string,
  lineUserId: string,
): Promise<LineThreadState | null> {
  const raw = await ctx.state.get(companyState(companyId, threadStateKey(lineUserId)));
  const thread = asRecord(raw);
  if (!thread) return null;
  if (
    typeof thread.paperclipIssueId !== "string" ||
    (thread.status !== "open" && thread.status !== "closed") ||
    typeof thread.lastActivityAt !== "string"
  ) {
    return null;
  }
  return {
    paperclipIssueId: thread.paperclipIssueId,
    status: thread.status,
    lastActivityAt: thread.lastActivityAt,
    lastCommentId: typeof thread.lastCommentId === "string" ? thread.lastCommentId : undefined,
  };
}

async function setThreadState(
  ctx: PluginContext,
  companyId: string,
  lineUserId: string,
  value: LineThreadState,
): Promise<void> {
  await withLock(STATE_KEYS.threadIndex, async () => {
    await ctx.state.set(companyState(companyId, threadStateKey(lineUserId)), value);
    const entries = await getThreadIndex(ctx);
    const filtered = entries.filter((entry) => !(entry.companyId === companyId && entry.lineUserId === lineUserId));
    if (value.status === "open") {
      filtered.push({ companyId, lineUserId });
    }
    await setThreadIndex(ctx, filtered);
  });
}

function formatUnsupportedMessageComment(messageType: string | undefined): string {
  const label = messageType?.trim() || "unknown";
  return [`[LINE ${label}]`, "Unsupported inbound LINE message type. Attachment relay was skipped."].join("\n");
}

function formatTextMessageComment(text: string | undefined): string {
  if (typeof text === "string" && text.length > 0) return text;
  return "[LINE text]\nEmpty text message received.";
}

function formatAttachmentComment(
  messageType: SupportedAttachmentMessageType,
  result: RelayAttachmentResult,
): string {
  if (!result.ok) {
    return [`[LINE ${messageType}]`, `Attachment relay failed: ${result.reason}`].join("\n");
  }
  return [
    `[LINE ${messageType}]`,
    `Filename: ${result.filename}`,
    `Content-Type: ${result.contentType}`,
    `Bytes: ${result.byteSize}`,
    `Bucket: ${result.bucketName}`,
    `Object Key: ${result.objectKey}`,
    `Attachment URL: ${result.url}`,
    `URL Expires At: ${result.expiresAt}`,
    `Lifecycle: remove from attachment bucket after ${result.lifecycleDays} days`,
  ].join("\n");
}

function formatAttachmentSizeLimitError(byteSize: number): string {
  return [
    "LINE content fetch exceeded attachment size limit",
    `(${byteSize} bytes > ${MAX_LINE_ATTACHMENT_BYTES} bytes)`,
  ].join(" ");
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

async function readBoundedResponseBody(response: Response): Promise<Buffer> {
  const declaredByteSize = parseContentLength(response.headers.get("content-length"));
  if (declaredByteSize !== null && declaredByteSize > MAX_LINE_ATTACHMENT_BYTES) {
    throw new Error(formatAttachmentSizeLimitError(declaredByteSize));
  }

  if (!response.body) {
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > MAX_LINE_ATTACHMENT_BYTES) {
      throw new Error(formatAttachmentSizeLimitError(body.length));
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;

    totalBytes += value.byteLength;
    if (totalBytes > MAX_LINE_ATTACHMENT_BYTES) {
      await reader.cancel("LINE attachment exceeded size limit").catch(() => undefined);
      throw new Error(formatAttachmentSizeLimitError(totalBytes));
    }

    chunks.push(value);
  }

  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes);
}

async function fetchLineMessageContent(
  ctx: PluginContext,
  config: LineBridgeConfig,
  input: {
    messageId: string;
    messageType: SupportedAttachmentMessageType;
    preferredFilename?: string | null;
  },
): Promise<LineAttachmentContent> {
  const accessToken = await getLineAccessToken(ctx, config);
  const response = await ctx.http.fetch(
    `${LINE_API.contentBaseUrl}/${encodeURIComponent(input.messageId)}/content`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LINE content fetch failed with ${response.status}${body ? `: ${body}` : ""}`);
  }

  const body = await readBoundedResponseBody(response);
  if (body.length === 0) {
    throw new Error("LINE content fetch returned an empty body");
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  return {
    body,
    contentType,
    byteSize: body.length,
    filename: buildAttachmentFilename({
      messageType: input.messageType,
      messageId: input.messageId,
      contentType,
      preferredFilename: input.preferredFilename,
    }),
  };
}

async function uploadIssueAttachment(
  ctx: PluginContext,
  config: LineBridgeConfig,
  input: {
    companyId: string;
    issueId: string;
    messageId: string;
    attachment: LineAttachmentContent;
  },
): Promise<RelayAttachmentResult> {
  const paperclipApiBaseUrl = resolvePaperclipApiBaseUrl(config);
  if (!paperclipApiBaseUrl) {
    return { ok: false, reason: "paperclipApiBaseUrl is not configured" };
  }
  if (!config.attachmentBucketName.trim()) {
    return { ok: false, reason: "attachmentBucketName is not configured" };
  }

  const objectKey = [
    input.companyId,
    ATTACHMENT_OBJECT_PREFIX,
    sanitizeObjectKeySegment(config.attachmentBucketName),
    "issues",
    sanitizeObjectKeySegment(input.issueId),
    "messages",
    sanitizeObjectKeySegment(input.messageId),
    sanitizeObjectKeySegment(input.attachment.filename),
  ].join("/");
  const signedUrlTtlSeconds = config.attachmentSignedUrlTtlDays * 24 * 60 * 60;

  const formData = new FormData();
  formData.set(
    "file",
    new Blob([new Uint8Array(input.attachment.body)], { type: input.attachment.contentType }),
    input.attachment.filename,
  );
  formData.set("objectKey", objectKey);
  formData.set("signedUrlTtlSeconds", String(signedUrlTtlSeconds));

  const headers: Record<string, string> = {};
  if (config.paperclipBoardApiKeyRef) {
    const boardApiKey = await ctx.secrets.resolve(config.paperclipBoardApiKeyRef);
    if (boardApiKey) {
      headers.Authorization = `Bearer ${boardApiKey}`;
    }
  }

  const response = await ctx.http.fetch(
    `${paperclipApiBaseUrl}/api/companies/${encodeURIComponent(input.companyId)}/issues/${encodeURIComponent(input.issueId)}/attachments`,
    {
      method: "POST",
      headers,
      body: formData,
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `Paperclip attachment upload failed with ${response.status}${body ? `: ${body}` : ""}`,
    };
  }

  const payload = asRecord(await response.json().catch(() => null));
  if (typeof payload?.signedContentPath !== "string") {
    return { ok: false, reason: "Paperclip attachment upload did not return a signedContentPath" };
  }
  if (typeof payload.signedUrlExpiresAt !== "string") {
    return { ok: false, reason: "Paperclip attachment upload did not return a signedUrlExpiresAt" };
  }

  return {
    ok: true,
    attachmentId: typeof payload.id === "string" ? payload.id : null,
    url: new URL(payload.signedContentPath, paperclipApiBaseUrl).toString(),
    filename:
      typeof payload.originalFilename === "string" && payload.originalFilename.length > 0
        ? payload.originalFilename
        : input.attachment.filename,
    contentType:
      typeof payload.contentType === "string" && payload.contentType.length > 0
        ? payload.contentType
        : input.attachment.contentType,
    byteSize: typeof payload.byteSize === "number" ? payload.byteSize : input.attachment.byteSize,
    objectKey: typeof payload.objectKey === "string" ? payload.objectKey : objectKey,
    bucketName: config.attachmentBucketName,
    expiresAt: payload.signedUrlExpiresAt,
    lifecycleDays: ATTACHMENT_LIFECYCLE_DAYS,
  };
}

async function relayInboundAttachment(
  ctx: PluginContext,
  config: LineBridgeConfig,
  input: {
    companyId: string;
    issueId: string;
    lineUserId: string;
    requestId: string;
    messageId: string;
    messageType: SupportedAttachmentMessageType;
    preferredFilename?: string | null;
  },
): Promise<RelayAttachmentResult> {
  try {
    const attachment = await fetchLineMessageContent(ctx, config, {
      messageId: input.messageId,
      messageType: input.messageType,
      preferredFilename: input.preferredFilename,
    });
    return await uploadIssueAttachment(ctx, config, {
      companyId: input.companyId,
      issueId: input.issueId,
      messageId: input.messageId,
      attachment,
    });
  } catch (error) {
    ctx.logger.warn("Failed to relay inbound LINE attachment", {
      companyId: input.companyId,
      issueId: input.issueId,
      lineUserId: input.lineUserId,
      requestId: input.requestId,
      messageId: input.messageId,
      messageType: input.messageType,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function buildInboundCommentBody(
  ctx: PluginContext,
  config: LineBridgeConfig,
  input: {
    companyId: string;
    issueId: string;
    lineUserId: string;
    requestId: string;
    event: LineWebhookEvent;
  },
): Promise<string> {
  const message = input.event.message;
  const messageType = typeof message?.type === "string" ? message.type : undefined;

  if (messageType === "text") {
    return formatTextMessageComment(message?.text);
  }

  if (!isSupportedAttachmentMessageType(messageType)) {
    return formatUnsupportedMessageComment(messageType);
  }

  const messageId = typeof message?.id === "string" ? message.id : null;
  if (!messageId) {
    return formatAttachmentComment(messageType, {
      ok: false,
      reason: "LINE attachment message is missing a message id",
    });
  }

  const result = await relayInboundAttachment(ctx, config, {
    companyId: input.companyId,
    issueId: input.issueId,
    lineUserId: input.lineUserId,
    requestId: input.requestId,
    messageId,
    messageType,
    preferredFilename: typeof message?.fileName === "string" ? message.fileName : null,
  });
  await tryUpdateLineOpsState(ctx, (state) => {
    if (result.ok) {
      state.attachmentRelaySucceeded += 1;
    } else {
      state.attachmentRelayFailed += 1;
    }
  });
  await writeMetric(ctx, result.ok ? "line.attachment.relay_succeeded" : "line.attachment.relay_failed", 1, {
    companyId: input.companyId,
    messageType,
  });
  return formatAttachmentComment(messageType, result);
}

function isThreadIdle(thread: LineThreadState, idleCloseMinutes: number): boolean {
  const lastActivityMs = Date.parse(thread.lastActivityAt);
  if (Number.isNaN(lastActivityMs)) return true;
  return Date.now() - lastActivityMs >= idleCloseMinutes * 60 * 1000;
}

async function closeLineThread(input: {
  ctx: PluginContext;
  companyId: string;
  lineUserId: string;
  thread: LineThreadState;
  closedAt: string;
  reason: "idle" | "tool_close" | "manual";
}): Promise<void> {
  const closedSession = await closeThreadSession({
    ctx: input.ctx,
    companyId: input.companyId,
    issueId: input.thread.paperclipIssueId,
    closedAt: input.closedAt,
    reason: input.reason,
  });

  if (closedSession?.agentId.startsWith("acp:")) {
    await tryUpdateLineOpsState(input.ctx, (state) => {
      state.acpClosed += 1;
    });
    await writeMetric(input.ctx, "line.acp.close", 1, {
      companyId: input.companyId,
      reason: input.reason,
    });
  }

  const issue = await input.ctx.issues.get(input.thread.paperclipIssueId, input.companyId);
  if (issue && !["done", "cancelled"].includes(issue.status)) {
    await input.ctx.issues.update(issue.id, { status: "done" }, input.companyId);
  }

  await setThreadState(input.ctx, input.companyId, input.lineUserId, {
    paperclipIssueId: input.thread.paperclipIssueId,
    status: "closed",
    lastActivityAt: input.closedAt,
    lastCommentId: input.thread.lastCommentId,
  });

  // After the local close completes, give downstream consumers a chance to
  // react. The hook is best-effort: failures are logged and never block the
  // close path.
  if (registeredExtensions.onCloseThread) {
    try {
      const principal = await getPrincipalState(input.ctx, input.lineUserId);
      if (principal) {
        await registeredExtensions.onCloseThread({
          log: input.ctx.logger,
          reason: input.reason,
          principal,
        });
      }
    } catch (error) {
      input.ctx.logger.warn("onCloseThread extension hook threw", {
        lineUserId: input.lineUserId,
        companyId: input.companyId,
        issueId: input.thread.paperclipIssueId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function getOrCreateOpenIssue(input: {
  ctx: PluginContext;
  principal: ResolvedActivePrincipal;
  lineUserId: string;
  occurredAt: string;
}) {
  const { ctx, principal, lineUserId, occurredAt } = input;
  const existingThread = await getThreadState(ctx, principal.paperclipCompany, lineUserId);
  if (existingThread?.status === "open") {
    const issue = await ctx.issues.get(existingThread.paperclipIssueId, principal.paperclipCompany);
    if (issue && !["done", "cancelled"].includes(issue.status)) {
      return { issue, created: false };
    }
  }

  if (existingThread) {
    await closeThreadSession({
      ctx,
      companyId: principal.paperclipCompany,
      issueId: existingThread.paperclipIssueId,
      closedAt: occurredAt,
      reason: existingThread.status === "closed" ? "thread_closed" : "issue_not_reusable",
    });
  }

  const titleLabel = principal.displayName?.trim() || lineUserId;
  const issue = await ctx.issues.create({
    companyId: principal.paperclipCompany,
    title: `LINE thread: ${titleLabel}`,
    description: `Inbound LINE conversation for ${titleLabel}.`,
    priority: "high",
  });

  await setThreadState(ctx, principal.paperclipCompany, lineUserId, {
    paperclipIssueId: issue.id,
    status: "open",
    lastActivityAt: occurredAt,
  });

  return { issue, created: true };
}

async function resolveActivePrincipal(
  ctx: PluginContext,
  lineUserId: string,
): Promise<ResolvedActivePrincipal | null> {
  const raw = await ctx.state.get({
    scopeKind: "instance",
    stateKey: getPrincipalStateKey(lineUserId),
  });
  return toResolvedActivePrincipal(raw);
}

async function fetchLineProfile(
  ctx: PluginContext,
  config: LineBridgeConfig,
  lineUserId: string,
): Promise<{
  displayName: string | null;
  pictureUrl: string | null;
  statusMessage: string | null;
  language: string | null;
}> {
  if (!config.lineChannelAccessTokenRef) {
    return { displayName: null, pictureUrl: null, statusMessage: null, language: null };
  }

  const accessToken = await ctx.secrets.resolve(config.lineChannelAccessTokenRef);
  const response = await ctx.http.fetch(`${LINE_API.profileBaseUrl}/${encodeURIComponent(lineUserId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    return { displayName: null, pictureUrl: null, statusMessage: null, language: null };
  }

  const body = asRecord(await response.json().catch(() => null));
  return {
    displayName: typeof body?.displayName === "string" ? body.displayName : null,
    pictureUrl: typeof body?.pictureUrl === "string" ? body.pictureUrl : null,
    statusMessage: typeof body?.statusMessage === "string" ? body.statusMessage : null,
    language: typeof body?.language === "string" ? body.language : null,
  };
}

async function provisionUnknownPrincipal(
  ctx: PluginContext,
  config: LineBridgeConfig,
  lineUserId: string,
): Promise<PrincipalState | null> {
  return await withLock(principalLockKey(lineUserId), async () => {
    const latest = await getPrincipalState(ctx, lineUserId);
    if (latest && latest.status === PRINCIPAL_STATUSES.active) return latest;

    const profile = await fetchLineProfile(ctx, config, lineUserId);
    let paperclipCompany = config.defaultPaperclipCompany.trim();
    let agentId = config.defaultAgentId.trim();
    let preferredLocale: string | null = profile.language;
    let metadata: Record<string, string> | undefined;

    if (registeredExtensions.onProvisionPrincipal) {
      const hookCtx: ProvisionPrincipalContext = {
        log: ctx.logger,
        config: {
          defaultPaperclipCompany: config.defaultPaperclipCompany,
          defaultAgentId: config.defaultAgentId,
          paperclipApiBaseUrl: config.paperclipApiBaseUrl,
        },
        profile: {
          displayName: profile.displayName,
          pictureUrl: profile.pictureUrl,
          statusMessage: profile.statusMessage,
          language: profile.language,
        },
      };

      let hookResult: Awaited<ReturnType<NonNullable<LineBridgeExtensions["onProvisionPrincipal"]>>> = null;
      try {
        hookResult = (await registeredExtensions.onProvisionPrincipal(hookCtx, lineUserId)) ?? null;
      } catch (error) {
        ctx.logger.error("onProvisionPrincipal extension hook threw", {
          lineUserId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }

      if (!hookResult) return null;

      paperclipCompany = hookResult.paperclipCompany;
      agentId = hookResult.agentId;
      if (typeof hookResult.preferredLocale === "string" && hookResult.preferredLocale.length > 0) {
        preferredLocale = hookResult.preferredLocale;
      }
      if (hookResult.metadata && Object.keys(hookResult.metadata).length > 0) {
        metadata = { ...hookResult.metadata };
      }
    }

    if (!paperclipCompany || !agentId) {
      ctx.logger.warn("LINE webhook event dropped: no provisioning hook and no default mapping configured", {
        lineUserId,
      });
      await tryUpdateLineOpsState(ctx, (state) => {
        state.webhookDroppedUnmapped += 1;
      });
      await writeMetric(ctx, "line.webhook.dropped_unmapped", 1, { lineUserId });
      return null;
    }

    const principal: PrincipalState = {
      version: 1,
      lineUserId,
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
      status: PRINCIPAL_STATUSES.active,
      linkedAt: new Date().toISOString(),
      paperclipCompany,
      agentId,
      preferredLocale,
      ...(metadata ? { metadata } : {}),
    };
    await setPrincipalState(ctx, lineUserId, principal);
    return principal;
  });
}

async function processQueuedEvent(
  ctx: PluginContext,
  queuedEvent: QueuedLineEvent,
  options?: { queueLockHeld?: boolean },
): Promise<ProcessedLineEvent> {
  const { event, lineUserId, requestId, dedupKey } = queuedEvent;

  if (event.source?.type !== "user") {
    return {
      dedupKey,
      processedAt: new Date().toISOString(),
      outcome: "skipped",
      requestId,
      lineUserId,
      reason: "unsupported_source",
    };
  }

  let principalState = await getPrincipalState(ctx, lineUserId);
  if (!principalState || principalState.status !== PRINCIPAL_STATUSES.active) {
    const config = await getConfig(ctx);
    principalState = await provisionUnknownPrincipal(ctx, config, lineUserId);
  }

  const principal = toResolvedActivePrincipal(principalState);
  if (!principal) {
    return {
      dedupKey,
      processedAt: new Date().toISOString(),
      outcome: "skipped",
      requestId,
      lineUserId,
      reason: "principal_unmapped_or_inactive",
    };
  }

  return await processQueuedEventWithActivePrincipal(ctx, queuedEvent, principal, options);
}

async function processQueuedEventWithActivePrincipal(
  ctx: PluginContext,
  queuedEvent: QueuedLineEvent,
  principal: ResolvedActivePrincipal,
  options?: { queueLockHeld?: boolean },
): Promise<ProcessedLineEvent> {
  const { event, lineUserId, requestId, dedupKey } = queuedEvent;

  if (event.type !== "message") {
    return {
      dedupKey,
      processedAt: new Date().toISOString(),
      outcome: "skipped",
      requestId,
      lineUserId,
      reason: "unsupported_event",
    };
  }

  const existingDeliveryContext = queuedEvent.deliveryContext;
  const deliveryTarget = await resolveDeliveryTarget(ctx, principal, existingDeliveryContext?.agentId);
  if (deliveryTarget.kind === "none") {
    ctx.logger.warn("Skipping LINE event: no agent available for principal", {
      requestId,
      lineUserId,
      paperclipCompany: principal.paperclipCompany,
    });
    return {
      dedupKey,
      processedAt: new Date().toISOString(),
      outcome: "skipped",
      requestId,
      lineUserId,
      reason: "no_agent",
    };
  }
  if (deliveryTarget.kind === "native_unavailable") {
    ctx.logger.warn("Skipping LINE event: native agent is not runnable", {
      requestId,
      lineUserId,
      paperclipCompany: principal.paperclipCompany,
      agentId: deliveryTarget.agentId,
      agentStatus: deliveryTarget.status,
    });
    return {
      dedupKey,
      processedAt: new Date().toISOString(),
      outcome: "skipped",
      requestId,
      lineUserId,
      reason: "agent_unavailable",
    };
  }

  const sessionMode: SessionMode = deliveryTarget.kind === "native" ? "native" : "acp";
  const agentId = deliveryTarget.agentId;
  if (sessionMode === "acp") {
    ctx.logger.info("Routing LINE turn via ACP fallback", {
      requestId,
      lineUserId,
      paperclipCompany: principal.paperclipCompany,
      agentName: agentId,
    });
  }

  return await withLock(
    threadLockKey(existingDeliveryContext?.companyId ?? principal.paperclipCompany, lineUserId),
    async () => {
      let deliveryCompanyId = existingDeliveryContext?.companyId ?? principal.paperclipCompany;
      let deliveryIssueId = existingDeliveryContext?.issueId;
      let deliveryCommentId = existingDeliveryContext?.commentId;
      const deliveryAgentId = agentId;
      const occurredAt = existingDeliveryContext?.occurredAt
        ?? (typeof event.timestamp === "number" ? new Date(event.timestamp).toISOString() : new Date().toISOString());
      let threadOutcome = existingDeliveryContext?.threadOutcome;
      let issue;
      if (!deliveryIssueId || !threadOutcome) {
        const createdIssue = await getOrCreateOpenIssue({
          ctx,
          principal,
          lineUserId,
          occurredAt,
        });
        issue = createdIssue.issue;
        deliveryCompanyId = principal.paperclipCompany;
        deliveryIssueId = issue.id;
        threadOutcome = createdIssue.created ? "created_thread" : "reused_thread";

        await setQueuedEventWithOptions(
          ctx,
          {
            ...queuedEvent,
            deliveryContext: {
              companyId: deliveryCompanyId,
              issueId: deliveryIssueId,
              agentId: deliveryAgentId,
              occurredAt,
              threadOutcome,
            },
          },
          { lockHeld: options?.queueLockHeld },
        );
      } else {
        issue = await ctx.issues.get(deliveryIssueId, deliveryCompanyId);
        if (!issue) {
          throw new Error(`Missing LINE issue ${deliveryIssueId} for queued event ${dedupKey}`);
        }
      }

      const threadState = await getThreadState(ctx, deliveryCompanyId, lineUserId);
      const config = await getConfig(ctx);
      const sessionText = typeof event.message?.text === "string" ? event.message.text : null;
      const isTextMessage = event.message?.type === "text" && sessionText !== null;
      if (!deliveryCommentId) {
        if (
          threadState?.paperclipIssueId === deliveryIssueId &&
          threadState.lastActivityAt === occurredAt &&
          typeof threadState.lastCommentId === "string"
        ) {
          deliveryCommentId = threadState.lastCommentId;
        } else {
          const commentBody = await buildInboundCommentBody(ctx, config, {
            companyId: deliveryCompanyId,
            issueId: deliveryIssueId,
            lineUserId,
            requestId,
            event,
          });
          const comment = await ctx.issues.createComment(
            deliveryIssueId,
            commentBody,
            deliveryCompanyId,
          );
          deliveryCommentId = comment.id;

          await setQueuedEventWithOptions(
            ctx,
            {
              ...queuedEvent,
              deliveryContext: {
                companyId: deliveryCompanyId,
                issueId: deliveryIssueId,
                commentId: deliveryCommentId,
                agentId: deliveryAgentId,
                occurredAt,
                threadOutcome,
              },
            },
            { lockHeld: options?.queueLockHeld },
          );
        }
      }

      await rememberReplyTokenForComment(ctx, {
        companyId: deliveryCompanyId,
        commentId: deliveryCommentId,
        lineUserId,
        event,
        capturedAt: occurredAt,
      });

      if (sessionMode === "native" && issue.assigneeAgentId !== deliveryAgentId) {
        issue = await ctx.issues.update(
          deliveryIssueId,
          { assigneeAgentId: deliveryAgentId },
          deliveryCompanyId,
        );
      }

      if (
        threadState?.paperclipIssueId !== deliveryIssueId ||
        threadState.status !== "open" ||
        threadState.lastActivityAt !== occurredAt ||
        threadState.lastCommentId !== deliveryCommentId
      ) {
        await setThreadState(ctx, deliveryCompanyId, lineUserId, {
          paperclipIssueId: deliveryIssueId,
          status: "open",
          lastActivityAt: occurredAt,
          lastCommentId: deliveryCommentId,
        });
      }

      if (!deliveryIssueId || !deliveryCommentId || !threadOutcome) {
        throw new Error(`Incomplete LINE delivery context for queued event ${dedupKey}`);
      }

      await setQueuedEventWithOptions(
        ctx,
        {
          ...queuedEvent,
          deliveryContext: {
            companyId: deliveryCompanyId,
            issueId: deliveryIssueId,
            commentId: deliveryCommentId,
            agentId: deliveryAgentId,
            occurredAt,
            threadOutcome,
          },
        },
        { lockHeld: options?.queueLockHeld },
      );

      let resultReason = `${threadOutcome}:comment_only`;
      if (isTextMessage) {
        const sessionDelivery = await deliverLineTurnToSession({
          ctx,
          companyId: deliveryCompanyId,
          issueId: deliveryIssueId,
          lineUserId,
          agentId: deliveryAgentId,
          commentId: deliveryCommentId,
          text: sessionText,
          occurredAt,
          mode: sessionMode,
          onEvent: sessionMode === "native"
            ? (event) => handleLineSessionEventPush({
                ctx,
                config,
                companyId: deliveryCompanyId,
                agentId: deliveryAgentId,
                lineUserId,
                issueId: deliveryIssueId,
                event,
              })
            : undefined,
        });

        if (!sessionDelivery.delivered) {
          ctx.logger.warn("LINE turn delivery failed; leaving event queued for retry", {
            issueId: deliveryIssueId,
            lineUserId,
            paperclipCompany: deliveryCompanyId,
            agentId: deliveryAgentId,
            mode: sessionMode,
          });
          throw new Error(`LINE session delivery failed for queued event ${dedupKey}`);
        }

        if (sessionMode === "acp") {
          await tryUpdateLineOpsState(ctx, (state) => {
            if (sessionDelivery.reason === "reused") {
              state.acpMessages += 1;
            } else {
              state.acpSpawned += 1;
              state.acpMessages += 1;
            }
          });
          await writeMetric(ctx, "line.acp.spawn", sessionDelivery.reason === "reused" ? 0 : 1, {
            companyId: deliveryCompanyId,
            agentName: deliveryAgentId,
          });
          await writeMetric(ctx, "line.acp.message", 1, {
            companyId: deliveryCompanyId,
            agentName: deliveryAgentId,
          });
        }

        resultReason = `${threadOutcome}:${sessionDelivery.reason}`;
      }

      return {
        dedupKey,
        processedAt: new Date().toISOString(),
        outcome: "processed",
        requestId,
        lineUserId,
        issueId: deliveryIssueId,
        commentId: deliveryCommentId,
        reason: resultReason,
      };
    },
  );
}

function getResolvedStringParam(params: unknown, key: string): string | null {
  const record = asRecord(params);
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function truncateLineText(value: string, maxLength = 450): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

async function getLineAccessToken(ctx: PluginContext, config: LineBridgeConfig): Promise<string> {
  if (!config.lineChannelAccessTokenRef) {
    throw new Error("lineChannelAccessTokenRef is required for outbound LINE calls");
  }
  const accessToken = await ctx.secrets.resolve(config.lineChannelAccessTokenRef);
  if (!accessToken) {
    throw new Error("LINE channel access token did not resolve");
  }
  return accessToken;
}

async function sendLineReplyMessages(
  ctx: PluginContext,
  config: LineBridgeConfig,
  replyToken: string,
  messages: Record<string, unknown>[],
): Promise<void> {
  const accessToken = await getLineAccessToken(ctx, config);
  const response = await ctx.http.fetch(LINE_API.replyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      replyToken,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LINE reply failed with ${response.status}${body ? `: ${body}` : ""}`);
  }
}

async function sendLinePushMessages(
  ctx: PluginContext,
  config: LineBridgeConfig,
  lineUserId: string,
  messages: Record<string, unknown>[],
): Promise<void> {
  const accessToken = await getLineAccessToken(ctx, config);
  const response = await ctx.http.fetch(LINE_API.pushUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: lineUserId,
      messages,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LINE push failed with ${response.status}${body ? `: ${body}` : ""}`);
  }
}

async function recordLinePushAttempt(
  ctx: PluginContext,
  input: {
    companyId: string;
    agentId: string;
    lineUserId: string;
    messageType: string;
    source: "tool" | "session_stream" | "acp_relay";
  },
): Promise<void> {
  await tryUpdateLineOpsState(ctx, (state) => {
    state.linePushAttempted += 1;
  });
  await writeMetric(ctx, "line.push.attempted", 1, {
    companyId: input.companyId,
    agentId: input.agentId,
    messageType: input.messageType,
    source: input.source,
  });
}

async function recordLinePushOutcome(
  ctx: PluginContext,
  outcome: "succeeded" | "failed",
  input: {
    companyId: string;
    agentId: string;
    lineUserId: string;
    messageType: string;
    source: "tool" | "session_stream" | "acp_relay";
  },
): Promise<void> {
  await tryUpdateLineOpsState(ctx, (state) => {
    if (outcome === "succeeded") {
      state.linePushSucceeded += 1;
    } else {
      state.linePushFailed += 1;
    }
  });
  await writeMetric(ctx, `line.push.${outcome}`, 1, {
    companyId: input.companyId,
    agentId: input.agentId,
    messageType: input.messageType,
    source: input.source,
  });
}

async function reserveLinePushBudget(
  ctx: PluginContext,
  config: LineBridgeConfig,
  input: {
    companyId: string;
    agentId: string;
    lineUserId: string;
    messageType: string;
  },
): Promise<
  | { ok: true; counter: PushCounterState }
  | {
      ok: false;
      data: Record<string, unknown>;
    }
> {
  const configuredLimit = Number.isFinite(config.linePushDailyLimit)
    ? config.linePushDailyLimit
    : DEFAULT_CONFIG.linePushDailyLimit;
  const limit = Math.max(0, Math.floor(configuredLimit));
  const dateKey = getUtcDateKey();
  const stateKey = pushCounterStateKey(dateKey, input.companyId, input.agentId);
  const entry: PushCounterIndexEntry = {
    dateKey,
    companyId: input.companyId,
    agentId: input.agentId,
    stateKey,
  };

  await recordLinePushAttempt(ctx, {
    ...input,
    source: "tool",
  });

  return await withLock(stateKey, async () => {
    const current = await getPushCounter(ctx, entry, limit);
    current.limit = limit;
    current.resetAt = getResetAtForUtcDate(dateKey);

    if (current.count >= limit) {
      const rejectedAt = new Date().toISOString();
      await tryUpdateLineOpsState(ctx, (state) => {
        state.linePushRejected += 1;
        state.lastPushLimitRejection = {
          companyId: input.companyId,
          agentId: input.agentId,
          lineUserId: input.lineUserId,
          messageType: input.messageType,
          dateKey,
          limit,
          rejectedAt,
        };
      });
      await writeMetric(ctx, "line.push.rejected", 1, {
        companyId: input.companyId,
        agentId: input.agentId,
        messageType: input.messageType,
        source: "tool",
      });
      try {
        await ctx.activity.log({
          companyId: input.companyId,
          message: "LINE push daily limit exhausted",
          entityType: "line_user",
          entityId: input.lineUserId,
          metadata: {
            agentId: input.agentId,
            dateKey,
            limit,
            messageType: input.messageType,
            resetAt: current.resetAt,
          },
        });
      } catch (error) {
        ctx.logger.warn("Failed to log LINE push limit rejection", {
          companyId: input.companyId,
          agentId: input.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return {
        ok: false,
        data: {
          lineUserId: input.lineUserId,
          companyId: input.companyId,
          agentId: input.agentId,
          messageType: input.messageType,
          dateKey,
          pushCount: current.count,
          pushLimit: limit,
          resetAt: current.resetAt,
        },
      };
    }

    // reserveLinePushBudget calls recordLinePushAttempt and reserves capacity
    // before sendLinePushMessages runs. Failed sends still consume budget by
    // design, which prevents intentional failure loops from bypassing limits.
    const next: PushCounterState = {
      ...current,
      count: current.count + 1,
      limit,
      resetAt: current.resetAt,
      updatedAt: new Date().toISOString(),
    };
    await rememberPushCounterIndexEntry(ctx, entry);
    await ctx.state.set(instanceState(stateKey, STATE_NAMESPACES.pushLimits), next);
    return { ok: true, counter: next };
  });
}

async function sendBudgetedLinePushTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  runCtx: ToolRunContext,
  input: {
    principal: ResolvedActivePrincipal;
    lineUserId: string;
    messageType: string;
    messages: Record<string, unknown>[];
    content: string;
  },
): Promise<ToolResult> {
  const budget = await reserveLinePushBudget(ctx, config, {
    companyId: input.principal.paperclipCompany,
    agentId: runCtx.agentId,
    lineUserId: input.lineUserId,
    messageType: input.messageType,
  });
  if (!budget.ok) {
    return toolErrorResult("line_push_daily_limit_exhausted", budget.data);
  }

  try {
    await sendLinePushMessages(ctx, config, input.lineUserId, input.messages);
    await recordLinePushOutcome(ctx, "succeeded", {
      companyId: input.principal.paperclipCompany,
      agentId: runCtx.agentId,
      lineUserId: input.lineUserId,
      messageType: input.messageType,
      source: "tool",
    });
  } catch (error) {
    await recordLinePushOutcome(ctx, "failed", {
      companyId: input.principal.paperclipCompany,
      agentId: runCtx.agentId,
      lineUserId: input.lineUserId,
      messageType: input.messageType,
      source: "tool",
    });
    throw error;
  }

  return {
    content: input.content,
    data: {
      lineUserId: input.lineUserId,
      companyId: input.principal.paperclipCompany,
      messageType: input.messageType,
      dateKey: budget.counter.dateKey,
      pushCount: budget.counter.count,
      pushLimit: budget.counter.limit,
      resetAt: budget.counter.resetAt,
    },
  };
}

function buildSessionEventLinePush(event: AgentSessionEvent): {
  category: "progress" | "error";
  text: string;
} | null {
  const message = typeof event.message === "string" ? truncateLineText(event.message) : "";

  if ((event.eventType === "chunk" || event.eventType === "status") && message.length > 0) {
    return {
      category: "progress",
      text: `Progress: ${message}`,
    };
  }

  if (event.eventType === "error") {
    return {
      category: "error",
      text: message.length > 0
        ? `Agent session error: ${message}`
        : "Agent session error: the current turn failed. The team has the thread context in Paperclip.",
    };
  }

  return null;
}

async function handleLineSessionEventPush(input: {
  ctx: PluginContext;
  config: LineBridgeConfig;
  companyId: string;
  agentId: string;
  lineUserId: string;
  issueId: string;
  event: AgentSessionEvent;
}): Promise<void> {
  const push = buildSessionEventLinePush(input.event);
  if (!push) return;

  const dedupKey = [
    input.issueId,
    input.lineUserId,
    input.event.sessionId,
    input.event.runId,
    push.category,
  ].join(":");
  if (sessionStreamingPushKeys.has(dedupKey)) return;
  sessionStreamingPushKeys.add(dedupKey);

  try {
    await recordLinePushAttempt(input.ctx, {
      companyId: input.companyId,
      agentId: input.agentId,
      lineUserId: input.lineUserId,
      messageType: push.category,
      source: "session_stream",
    });
    await sendLinePushMessages(input.ctx, input.config, input.lineUserId, [
      {
        type: "text",
        text: push.text,
      },
    ]);
    await recordLinePushOutcome(input.ctx, "succeeded", {
      companyId: input.companyId,
      agentId: input.agentId,
      lineUserId: input.lineUserId,
      messageType: push.category,
      source: "session_stream",
    });
  } catch (error) {
    await recordLinePushOutcome(input.ctx, "failed", {
      companyId: input.companyId,
      agentId: input.agentId,
      lineUserId: input.lineUserId,
      messageType: push.category,
      source: "session_stream",
    });
    input.ctx.logger.warn("Failed to push LINE session stream event", {
      issueId: input.issueId,
      lineUserId: input.lineUserId,
      sessionId: input.event.sessionId,
      runId: input.event.runId,
      eventType: input.event.eventType,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Relay an ACP `output` frame to LINE. Like the session-stream push path,
 * this bypasses the daily push budget because the agent's text is the user's
 * actual reply, not a tool-initiated outbound message.
 */
async function pushAcpRelay(
  ctx: PluginContext,
  binding: { companyId: string; lineUserId: string; agentName: string; issueId: string },
  type: "text" | "error",
  text: string,
): Promise<void> {
  const trimmed = truncateLineText(text);
  if (trimmed.length === 0) {
    await tryUpdateLineOpsState(ctx, (state) => {
      state.acpOutputDropped += 1;
    });
    return;
  }

  const config = await getConfig(ctx);
  const agentLabel = `acp:${binding.agentName}`;
  try {
    await recordLinePushAttempt(ctx, {
      companyId: binding.companyId,
      agentId: agentLabel,
      lineUserId: binding.lineUserId,
      messageType: type,
      source: "acp_relay",
    });
    await sendLinePushMessages(ctx, config, binding.lineUserId, [
      {
        type: "text",
        text: trimmed,
      },
    ]);
    await recordLinePushOutcome(ctx, "succeeded", {
      companyId: binding.companyId,
      agentId: agentLabel,
      lineUserId: binding.lineUserId,
      messageType: type,
      source: "acp_relay",
    });
    await tryUpdateLineOpsState(ctx, (state) => {
      state.acpOutputRelayed += 1;
    });
    await writeMetric(ctx, "line.acp.output_relayed", 1, {
      companyId: binding.companyId,
      agentName: binding.agentName,
      type,
    });
  } catch (error) {
    await recordLinePushOutcome(ctx, "failed", {
      companyId: binding.companyId,
      agentId: agentLabel,
      lineUserId: binding.lineUserId,
      messageType: type,
      source: "acp_relay",
    });
    await tryUpdateLineOpsState(ctx, (state) => {
      state.acpOutputDropped += 1;
    });
    ctx.logger.warn("Failed to push ACP relay to LINE", {
      companyId: binding.companyId,
      lineUserId: binding.lineUserId,
      issueId: binding.issueId,
      agentName: binding.agentName,
      type,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function isCommentMetaFresh(meta: CommentMetaState, maxAgeSeconds: number): boolean {
  const capturedAtMs = Date.parse(meta.capturedAt);
  if (Number.isNaN(capturedAtMs)) return false;
  return Date.now() - capturedAtMs <= maxAgeSeconds * 1000;
}

async function resolveScopedPrincipalForTool(
  ctx: PluginContext,
  callerCompanyId: string,
  lineUserId: string,
): Promise<ResolvedActivePrincipal | null> {
  const principal = await resolveActivePrincipal(ctx, lineUserId);
  if (!principal) return null;
  if (principal.paperclipCompany !== callerCompanyId) return null;
  return principal;
}

function toolErrorResult(error: string, data?: Record<string, unknown>): ToolResult {
  return {
    error,
    data,
  };
}

async function handleLineWebhook(
  ctx: PluginContext,
  config: LineBridgeConfig,
  input: PluginWebhookInput,
): Promise<void> {
  await verifyLineWebhookSignature(ctx, config, input);

  const parsed = asRecord(input.parsedBody) as LineWebhookBody | null;
  const events: LineWebhookEvent[] = Array.isArray(parsed?.events)
    ? parsed!.events!
    : (() => {
        try {
          const body = JSON.parse(input.rawBody) as LineWebhookBody;
          return Array.isArray(body.events) ? body.events : [];
        } catch {
          return [];
        }
      })();

  let queuedCount = 0;
  for (const event of events) {
    const lineUserId = event.source?.userId;
    if (event.source?.type !== "user" || typeof lineUserId !== "string" || lineUserId.length === 0) {
      continue;
    }

    const queued = await queueWebhookEvent(ctx, {
      dedupKey: buildEventDedupKey(event),
      event,
      lineUserId,
      queuedAt: new Date().toISOString(),
      requestId: input.requestId,
    });
    if (queued) queuedCount += 1;
  }

  const hasPendingWork = queuedCount > 0 || (await getPendingEventKeys(ctx)).length > 0;
  if (hasPendingWork) {
    scheduleNearRealtimeDrain(ctx);
  }

  ctx.logger.info("Processed LINE webhook delivery", {
    requestId: input.requestId,
    eventCount: events.length,
    queuedCount,
  });
  await tryUpdateLineOpsState(ctx, (state, receivedAt) => {
    state.webhookDeliveries += 1;
    state.webhookEventsQueued += queuedCount;
    state.lastWebhook = {
      endpointKey: input.endpointKey,
      requestId: input.requestId,
      eventCount: events.length,
      queuedCount,
      receivedAt,
    };
  });
  await writeMetric(ctx, "line.webhook.delivered", 1, { endpointKey: input.endpointKey });
  if (queuedCount > 0) {
    await writeMetric(ctx, "line.webhook.events_queued", queuedCount, { endpointKey: input.endpointKey });
  }
}

async function drainQueuedLineEvents(ctx: PluginContext, options: DrainQueuedLineEventsOptions): Promise<void> {
  const pendingKeys = await getPendingEventKeys(ctx);
  ctx.logger.info("Processing queued LINE events", {
    trigger: options.trigger,
    runId: options.runId,
    pendingCount: pendingKeys.length,
  });

  let failures = 0;
  for (const dedupKey of pendingKeys) {
    try {
      const outcome = await withLock(queuedEventStateKey(dedupKey), async () => {
        const processedState = instanceState(processedEventStateKey(dedupKey), STATE_NAMESPACES.events);
        const queuedState = instanceState(queuedEventStateKey(dedupKey), STATE_NAMESPACES.events);
        const processed = await ctx.state.get(processedState);
        if (processed) {
          await ctx.state.delete(queuedState);
          return "already_processed" as const;
        }

        const raw = await ctx.state.get(queuedState);
        if (!raw || typeof raw !== "object") {
          return "missing" as const;
        }

        const result = await processQueuedEvent(ctx, raw as QueuedLineEvent, {
          queueLockHeld: true,
        });
        await markEventProcessedWithOptions(ctx, result, { lockHeld: true });
        return "processed" as const;
      });

      if (outcome !== "processed") {
        await removePendingEventKey(ctx, dedupKey);
      }
    } catch (error) {
      failures += 1;
      ctx.logger.error("Failed to process queued LINE event", {
        dedupKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures > 0) {
    await tryUpdateLineOpsState(ctx, (state, completedAt) => {
      state.queueDrainRuns += 1;
      state.queueDrainFailures += failures;
      state.lastQueueDrain = {
        trigger: options.trigger,
        runId: options.runId,
        pendingCount: pendingKeys.length,
        failures,
        completedAt,
      };
    });
    await writeMetric(ctx, "line.queue.drain_failed", failures, { trigger: options.trigger });
    throw new Error(`Failed to process ${failures} queued LINE event(s)`);
  }

  await tryUpdateLineOpsState(ctx, (state, completedAt) => {
    state.queueDrainRuns += 1;
    state.lastQueueDrain = {
      trigger: options.trigger,
      runId: options.runId,
      pendingCount: pendingKeys.length,
      failures,
      completedAt,
    };
  });
  await writeMetric(ctx, "line.queue.drain_succeeded", 1, { trigger: options.trigger });
}

function scheduleNearRealtimeDrain(ctx: PluginContext): void {
  nearRealtimeDrainRequested = true;
  if (nearRealtimeDrainTimer || nearRealtimeDrainRunning) return;

  nearRealtimeDrainTimer = setTimeout(async () => {
    nearRealtimeDrainTimer = null;
    nearRealtimeDrainRunning = true;
    try {
      do {
        nearRealtimeDrainRequested = false;
        await drainQueuedLineEvents(ctx, { trigger: "webhook" });
      } while (nearRealtimeDrainRequested);
    } catch (error) {
      ctx.logger.error("Near-real-time LINE queue drain failed; scheduled retry will pick it up", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      nearRealtimeDrainRunning = false;
      if (nearRealtimeDrainRequested) {
        scheduleNearRealtimeDrain(ctx);
      }
    }
  }, 0);
}

function resetNearRealtimeDrainState(): void {
  if (nearRealtimeDrainTimer) {
    clearTimeout(nearRealtimeDrainTimer);
  }
  nearRealtimeDrainTimer = null;
  nearRealtimeDrainRunning = false;
  nearRealtimeDrainRequested = false;
  sessionStreamingPushKeys.clear();
}

async function registerJobHandlers(ctx: PluginContext): Promise<void> {
  ctx.jobs.register(JOB_KEYS.processEvent, async (jobCtx) => {
    await drainQueuedLineEvents(ctx, {
      trigger: jobCtx.trigger,
      runId: jobCtx.runId,
    });
  });

  ctx.jobs.register(JOB_KEYS.idleClose, async (jobCtx) => {
    const config = await getConfig(ctx);
    const entries = await getThreadIndex(ctx);
    let closed = 0;
    let pruned = 0;

    for (const entry of entries) {
      const outcome = await withLock(threadLockKey(entry.companyId, entry.lineUserId), async () => {
        const thread = await getThreadState(ctx, entry.companyId, entry.lineUserId);
        if (!thread || thread.status !== "open") {
          await withLock(STATE_KEYS.threadIndex, async () => {
            const current = await getThreadIndex(ctx);
            await setThreadIndex(
              ctx,
              current.filter(
                (candidate) => !(candidate.companyId === entry.companyId && candidate.lineUserId === entry.lineUserId),
              ),
            );
          });
          return "pruned" as const;
        }

        if (!isThreadIdle(thread, config.idleCloseMinutes)) {
          return "skipped" as const;
        }

        await closeLineThread({
          ctx,
          companyId: entry.companyId,
          lineUserId: entry.lineUserId,
          thread,
          closedAt: new Date().toISOString(),
          reason: "idle",
        });
        return "closed" as const;
      });

      if (outcome === "closed") {
        closed += 1;
      } else if (outcome === "pruned") {
        pruned += 1;
      }
    }

    ctx.logger.info("LINE idle-close job completed", {
      trigger: jobCtx.trigger,
      indexedCount: entries.length,
      closed,
      pruned,
    });
    await tryUpdateLineOpsState(ctx, (state) => {
      state.idleThreadsClosed += closed;
      state.idleThreadsPruned += pruned;
    });
    if (closed > 0) {
      await writeMetric(ctx, "line.idle_close.closed", closed, { trigger: jobCtx.trigger });
    }
    if (pruned > 0) {
      await writeMetric(ctx, "line.idle_close.pruned", pruned, { trigger: jobCtx.trigger });
    }
  });

  ctx.jobs.register(JOB_KEYS.replyTokenGc, async (jobCtx) => {
    const config = await getConfig(ctx);
    const entries = await getReplyTokenIndex(ctx);
    let removed = 0;

    for (const entry of entries) {
      const meta = await getCommentMeta(ctx, entry.companyId, entry.commentId);
      if (!meta || meta.usedAt || !isCommentMetaFresh(meta, config.replyTokenMaxAgeSeconds)) {
        await forgetCommentMeta(ctx, entry.companyId, entry.commentId);
        removed += 1;
      }
    }

    ctx.logger.info("LINE reply-token GC completed", {
      trigger: jobCtx.trigger,
      indexedCount: entries.length,
      removed,
    });
  });
}

async function handlePushTextTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const lineUserId = getResolvedStringParam(params, "lineUserId");
  const text = getResolvedStringParam(params, "text");
  if (!lineUserId || !text) {
    return toolErrorResult("lineUserId and text are required");
  }

  const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, lineUserId);
  if (!principal) {
    return toolErrorResult("line_user_not_in_caller_scope", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  return await sendBudgetedLinePushTool(ctx, config, runCtx, {
    principal,
    lineUserId,
    messageType: "text",
    messages: [{ type: "text", text }],
    content: `Sent LINE text to ${lineUserId}.`,
  });
}

async function handlePushImageTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const lineUserId = getResolvedStringParam(params, "lineUserId");
  const imageUrl = getResolvedStringParam(params, "imageUrl");
  if (!lineUserId || !imageUrl) {
    return toolErrorResult("lineUserId and imageUrl are required");
  }

  const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, lineUserId);
  if (!principal) {
    return toolErrorResult("line_user_not_in_caller_scope", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  const previewImageUrl = getResolvedStringParam(params, "previewImageUrl") ?? imageUrl;
  return await sendBudgetedLinePushTool(ctx, config, runCtx, {
    principal,
    lineUserId,
    messageType: "image",
    messages: [
      {
        type: "image",
        originalContentUrl: imageUrl,
        previewImageUrl,
      },
    ],
    content: `Sent LINE image to ${lineUserId}.`,
  });
}

async function handlePushFlexTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const lineUserId = getResolvedStringParam(params, "lineUserId");
  const altText = getResolvedStringParam(params, "altText");
  const contents = asRecord(asRecord(params)?.contents);
  if (!lineUserId || !altText || !contents) {
    return toolErrorResult("lineUserId, altText, and contents are required");
  }

  const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, lineUserId);
  if (!principal) {
    return toolErrorResult("line_user_not_in_caller_scope", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  return await sendBudgetedLinePushTool(ctx, config, runCtx, {
    principal,
    lineUserId,
    messageType: "flex",
    messages: [
      {
        type: "flex",
        altText,
        contents,
      },
    ],
    content: `Sent LINE flex message to ${lineUserId}.`,
  });
}

async function handlePushTemplateTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const lineUserId = getResolvedStringParam(params, "lineUserId");
  const altText = getResolvedStringParam(params, "altText");
  const template = asRecord(asRecord(params)?.template);
  if (!lineUserId || !altText || !template) {
    return toolErrorResult("lineUserId, altText, and template are required");
  }

  const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, lineUserId);
  if (!principal) {
    return toolErrorResult("line_user_not_in_caller_scope", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  return await sendBudgetedLinePushTool(ctx, config, runCtx, {
    principal,
    lineUserId,
    messageType: "template",
    messages: [
      {
        type: "template",
        altText,
        template,
      },
    ],
    content: `Sent LINE template message to ${lineUserId}.`,
  });
}

async function handlePushStickerTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const lineUserId = getResolvedStringParam(params, "lineUserId");
  const packageId = getResolvedStringParam(params, "packageId");
  const stickerId = getResolvedStringParam(params, "stickerId");
  if (!lineUserId || !packageId || !stickerId) {
    return toolErrorResult("lineUserId, packageId, and stickerId are required");
  }

  const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, lineUserId);
  if (!principal) {
    return toolErrorResult("line_user_not_in_caller_scope", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  return await sendBudgetedLinePushTool(ctx, config, runCtx, {
    principal,
    lineUserId,
    messageType: "sticker",
    messages: [
      {
        type: "sticker",
        packageId,
        stickerId,
      },
    ],
    content: `Sent LINE sticker to ${lineUserId}.`,
  });
}

async function handleAckWithReplyTokenTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const commentId = getResolvedStringParam(params, "commentId");
  const text = getResolvedStringParam(params, "text");
  if (!commentId || !text) {
    return toolErrorResult("commentId and text are required");
  }

  return await withLock(commentMetaStateKey(commentId), async () => {
    const meta = await getCommentMeta(ctx, runCtx.companyId, commentId);
    if (!meta) {
      await tryUpdateLineOpsState(ctx, (state) => {
        state.replyTokenMisses += 1;
      });
      await writeMetric(ctx, "line.reply_token.miss", 1, {
        companyId: runCtx.companyId,
        reason: "not_found",
      });
      return toolErrorResult("reply_token_not_found", {
        commentId,
        callerCompanyId: runCtx.companyId,
      });
    }
    if (meta.usedAt) {
      await forgetCommentMeta(ctx, runCtx.companyId, commentId);
      await tryUpdateLineOpsState(ctx, (state) => {
        state.replyTokenMisses += 1;
      });
      await writeMetric(ctx, "line.reply_token.miss", 1, {
        companyId: runCtx.companyId,
        reason: "already_used",
      });
      return toolErrorResult("reply_token_already_used", { commentId });
    }
    if (!isCommentMetaFresh(meta, config.replyTokenMaxAgeSeconds)) {
      await forgetCommentMeta(ctx, runCtx.companyId, commentId);
      await tryUpdateLineOpsState(ctx, (state) => {
        state.replyTokenMisses += 1;
      });
      await writeMetric(ctx, "line.reply_token.miss", 1, {
        companyId: runCtx.companyId,
        reason: "expired",
      });
      return toolErrorResult("reply_token_expired", { commentId });
    }

    const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, meta.lineUserId);
    if (!principal) {
      await tryUpdateLineOpsState(ctx, (state) => {
        state.replyTokenMisses += 1;
      });
      await writeMetric(ctx, "line.reply_token.miss", 1, {
        companyId: runCtx.companyId,
        reason: "scope",
      });
      return toolErrorResult("line_user_not_in_caller_scope", {
        lineUserId: meta.lineUserId,
        callerCompanyId: runCtx.companyId,
      });
    }

    await sendLineReplyMessages(ctx, config, meta.replyToken, [{ type: "text", text }]);
    await forgetCommentMeta(ctx, runCtx.companyId, commentId);
    return {
      content: `Acknowledged LINE comment ${commentId} with the cached reply token.`,
      data: {
        commentId,
        lineUserId: meta.lineUserId,
        companyId: principal.paperclipCompany,
        messageType: "reply",
      },
    };
  });
}

async function handleCloseThreadTool(
  ctx: PluginContext,
  _config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const lineUserId = getResolvedStringParam(params, "lineUserId");
  if (!lineUserId) {
    return toolErrorResult("lineUserId is required");
  }

  const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, lineUserId);
  if (!principal) {
    return toolErrorResult("line_user_not_in_caller_scope", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  const thread = await getThreadState(ctx, runCtx.companyId, lineUserId);
  if (!thread || thread.status !== "open") {
    return toolErrorResult("line_thread_not_open", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  await closeLineThread({
    ctx,
    companyId: runCtx.companyId,
    lineUserId,
    thread,
    closedAt: new Date().toISOString(),
    reason: "tool_close",
  });

  return {
    content: `Closed the open LINE thread for ${lineUserId}.`,
    data: {
      lineUserId,
      companyId: principal.paperclipCompany,
      issueId: thread.paperclipIssueId,
      status: "closed",
    },
  };
}

async function handleGetProfileTool(
  ctx: PluginContext,
  config: LineBridgeConfig,
  params: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const lineUserId = getResolvedStringParam(params, "lineUserId");
  if (!lineUserId) {
    return toolErrorResult("lineUserId is required");
  }

  const principal = await resolveScopedPrincipalForTool(ctx, runCtx.companyId, lineUserId);
  if (!principal) {
    return toolErrorResult("line_user_not_in_caller_scope", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  const liveProfile = await fetchLineProfile(ctx, config, lineUserId);
  if (liveProfile.displayName === null && liveProfile.pictureUrl === null) {
    return toolErrorResult("line_live_fetch_failed", {
      lineUserId,
      callerCompanyId: runCtx.companyId,
    });
  }

  return {
    content: `Fetched LINE profile for ${lineUserId}.`,
    data: {
      lineUserId,
      companyId: principal.paperclipCompany,
      displayName: liveProfile.displayName ?? principal.displayName ?? null,
      pictureUrl: liveProfile.pictureUrl ?? null,
      linkedAt: principal.linkedAt ?? null,
    },
  };
}

async function registerToolHandlers(ctx: PluginContext): Promise<void> {
  const handlers = new Map<
    string,
    (config: LineBridgeConfig, params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>
  >([
    [TOOL_NAMES.pushText, (config, params, runCtx) => handlePushTextTool(ctx, config, params, runCtx)],
    [TOOL_NAMES.pushImage, (config, params, runCtx) => handlePushImageTool(ctx, config, params, runCtx)],
    [TOOL_NAMES.pushFlex, (config, params, runCtx) => handlePushFlexTool(ctx, config, params, runCtx)],
    [TOOL_NAMES.pushTemplate, (config, params, runCtx) => handlePushTemplateTool(ctx, config, params, runCtx)],
    [TOOL_NAMES.pushSticker, (config, params, runCtx) => handlePushStickerTool(ctx, config, params, runCtx)],
    [TOOL_NAMES.ackWithReplyToken, (config, params, runCtx) => handleAckWithReplyTokenTool(ctx, config, params, runCtx)],
    [TOOL_NAMES.closeThread, (config, params, runCtx) => handleCloseThreadTool(ctx, config, params, runCtx)],
    [TOOL_NAMES.getProfile, (config, params, runCtx) => handleGetProfileTool(ctx, config, params, runCtx)],
  ]);

  for (const tool of manifest.tools ?? []) {
    ctx.tools.register(
      tool.name,
      {
        displayName: tool.displayName,
        description: tool.description,
        parametersSchema: tool.parametersSchema,
      },
      async (params, runCtx): Promise<ToolResult> => {
        const handler = handlers.get(tool.name);
        if (!handler) {
          return {
            error: `No handler registered for ${tool.name}.`,
            data: { toolName: tool.name },
          };
        }

        ctx.logger.info("LINE bridge tool invoked", {
          toolName: tool.name,
          companyId: runCtx.companyId,
        });
        const config = await getConfig(ctx);
        return await handler(config, params, runCtx);
      },
    );
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    resetNearRealtimeDrainState();
    currentContext = ctx;
    await registerJobHandlers(ctx);
    await registerToolHandlers(ctx);
    ctx.data.register(LINE_OPS_DATA_KEY, async () => await getLineOpsSnapshot(ctx));
    setAcpRelayHandler(async ({ binding, type, text }) => {
      await pushAcpRelay(ctx, binding, type, text);
    });
    registerAcpOutputListener(ctx);
    ctx.logger.info("LINE bridge setup complete", {
      pluginId: manifest.id,
      jobCount: getDeclaredJobKeys().length,
      toolCount: getDeclaredToolNames().length,
      webhookCount: getDeclaredWebhookKeys().length,
    });
  },

  async onHealth(): Promise<PluginHealthDiagnostics> {
    const ctx = currentContext;
    const declaredDetails = {
      declaredWebhooks: getDeclaredWebhookKeys().length,
      declaredJobs: getDeclaredJobKeys().length,
      declaredTools: getDeclaredToolNames().length,
    };
    let details: Record<string, unknown>;
    try {
      details = ctx ? await getLineOpsSnapshot(ctx) : declaredDetails;
    } catch (error) {
      details = {
        ...declaredDetails,
        snapshotError: error instanceof Error ? error.message : String(error),
      };
    }
    const lastQueueDrain = asRecord(details.lastQueueDrain);
    const lastQueueDrainFailures =
      typeof lastQueueDrain?.failures === "number" && Number.isFinite(lastQueueDrain.failures)
        ? lastQueueDrain.failures
        : 0;
    const queueDrainCurrentlyFailing = lastQueueDrainFailures > 0;
    const snapshotUnavailable = typeof details.snapshotError === "string";
    const message = snapshotUnavailable
      ? "LINE bridge health snapshot unavailable"
      : queueDrainCurrentlyFailing
        ? "LINE bridge has a currently failing queue drain"
        : "LINE bridge ready";
    return {
      status: queueDrainCurrentlyFailing || snapshotUnavailable ? "degraded" : "ok",
      message,
      details: {
        ...details,
        ...declaredDetails,
      },
    };
  },

  async onValidateConfig(config) {
    const typed = {
      ...DEFAULT_CONFIG,
      ...(config as Partial<LineBridgeConfig>),
    };
    const errors: string[] = [];
    const warnings: string[] = [];

    if (typed.attachmentSignedUrlTtlDays < 1) {
      errors.push("attachmentSignedUrlTtlDays must be at least 1");
    }
    if (typed.attachmentSignedUrlTtlDays > 90) {
      errors.push("attachmentSignedUrlTtlDays must be at most 90");
    }
    if (typed.idleCloseMinutes < 1) {
      errors.push("idleCloseMinutes must be at least 1");
    }
    if (!Number.isInteger(typed.linePushDailyLimit)) {
      errors.push("linePushDailyLimit must be an integer");
    }
    if (typed.linePushDailyLimit < 0) {
      errors.push("linePushDailyLimit must be at least 0");
    }
    if (typed.replyTokenMaxAgeSeconds < 1) {
      errors.push("replyTokenMaxAgeSeconds must be at least 1");
    }
    if (!typed.lineChannelSecretRef) {
      warnings.push("lineChannelSecretRef is not set yet; webhook signature verification is still unconfigured.");
    }
    if (!typed.lineChannelAccessTokenRef) {
      warnings.push("lineChannelAccessTokenRef is not set yet; outbound LINE calls will remain unavailable.");
    }
    if (!typed.paperclipBoardApiKeyRef) {
      warnings.push("paperclipBoardApiKeyRef is not set yet; authenticated attachment relay may be unavailable.");
    }
    if (!typed.attachmentBucketName?.trim()) {
      warnings.push("attachmentBucketName is not set yet; inbound attachment relay will write fallback comments only.");
    }
    if (!typed.paperclipApiBaseUrl?.trim() && !process.env.PAPERCLIP_API_URL?.trim()) {
      warnings.push("paperclipApiBaseUrl is not set yet; attachment relay cannot publish signed attachment URLs.");
    }
    const hasDefaults =
      typed.defaultPaperclipCompany.trim().length > 0 && typed.defaultAgentId.trim().length > 0;
    if (!hasDefaults && !registeredExtensions.onProvisionPrincipal) {
      warnings.push(
        "Neither defaultPaperclipCompany/defaultAgentId nor an onProvisionPrincipal extension hook is configured; inbound LINE events will be dropped.",
      );
    }

    return {
      ok: errors.length === 0,
      warnings,
      errors,
    };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (!getDeclaredWebhookKeys().includes(input.endpointKey)) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const ctx = currentContext;
    if (!ctx) {
      throw new Error("LINE bridge context is not ready");
    }

    await ctx.state.set(
      instanceState(`last-webhook:${input.endpointKey}`, STATE_NAMESPACES.webhooks),
      {
        endpointKey: input.endpointKey,
        requestId: input.requestId,
        receivedAt: new Date().toISOString(),
        rawBodySha256: createHash("sha256").update(input.rawBody).digest("hex"),
        rawBodyLength: input.rawBody.length,
      },
    );
    ctx.logger.info("LINE bridge webhook received", {
      endpointKey: input.endpointKey,
      requestId: input.requestId,
    });

    const config = await getConfig(ctx);
    try {
      if (input.endpointKey === WEBHOOK_KEYS.lineWebhook) {
        await handleLineWebhook(ctx, config, input);
        return;
      }
    } catch (error) {
      await tryUpdateLineOpsState(ctx, (state) => {
        state.webhookDeliveryFailures += 1;
      });
      await writeMetric(ctx, "line.webhook.failed", 1, { endpointKey: input.endpointKey });
      throw error;
    }
  },

  async onConfigChanged() {
    const ctx = currentContext;
    if (!ctx) return;
    const config = await getConfig(ctx);
    ctx.logger.info("LINE bridge config changed", {
      attachmentBucketName: config.attachmentBucketName,
      idleCloseMinutes: config.idleCloseMinutes,
      linePushDailyLimit: config.linePushDailyLimit,
      replyTokenMaxAgeSeconds: config.replyTokenMaxAgeSeconds,
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);

/**
 * ACP bridge.
 *
 * Wires `paperclip-plugin-line` to `mvanhorn/paperclip-plugin-acp`. When the
 * principal's configured `agentId` is not present in `ctx.agents.list`, the
 * worker treats it as an ACP agent name (e.g. `"claude"`, `"gemini"`) and
 * routes the turn to ACP via plugin-namespaced bus events:
 *
 *   plugin.paperclip-plugin-line.acp-spawn   { sessionId, agentName, chatId, threadId, companyId, mode }
 *   plugin.paperclip-plugin-line.acp-message { sessionId, text }
 *   plugin.paperclip-plugin-line.acp-close   { sessionId }
 *
 * The ACP plugin emits `plugin.paperclip-plugin-acp.output { sessionId, type, text, ... }`;
 * we subscribe in `setup` and relay text frames back to LINE via the normal
 * push pipeline.
 *
 * We follow the telegram reference pattern: chat plugin generates the
 * sessionId client-side and sends it inside the spawn payload.
 */

import { randomUUID } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  ACP_EVENT_NAMES,
  ACP_OUTPUT_EVENT,
  type AcpThreadBinding,
  STATE_NAMESPACES,
} from "./constants.js";

const ACP_BINDING_VERSION = 1;

export type AcpRelayHandler = (relay: {
  binding: AcpThreadBinding;
  type: "text" | "error";
  text: string;
}) => Promise<void>;

let registeredRelayHandler: AcpRelayHandler | null = null;
let outputListenerRegistered = false;

function bindingKey(acpSessionId: string): string {
  return `binding:${acpSessionId}`;
}

function bindingLocator(companyId: string, acpSessionId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: STATE_NAMESPACES.acp,
    stateKey: bindingKey(acpSessionId),
  };
}

function indexLocator() {
  return {
    scopeKind: "instance" as const,
    namespace: STATE_NAMESPACES.acp,
    stateKey: "binding-index",
  };
}

type AcpBindingIndexEntry = {
  companyId: string;
  acpSessionId: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseBinding(raw: unknown): AcpThreadBinding | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (
    typeof record.acpSessionId !== "string" ||
    typeof record.companyId !== "string" ||
    typeof record.lineUserId !== "string" ||
    typeof record.issueId !== "string" ||
    typeof record.agentName !== "string" ||
    typeof record.openedAt !== "string"
  ) {
    return null;
  }
  return {
    version: typeof record.version === "number" ? record.version : ACP_BINDING_VERSION,
    acpSessionId: record.acpSessionId,
    companyId: record.companyId,
    lineUserId: record.lineUserId,
    issueId: record.issueId,
    agentName: record.agentName,
    openedAt: record.openedAt,
  };
}

async function getBindingIndex(ctx: PluginContext): Promise<AcpBindingIndexEntry[]> {
  const raw = await ctx.state.get(indexLocator());
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is AcpBindingIndexEntry => {
    const record = asRecord(entry);
    return typeof record?.companyId === "string" && typeof record.acpSessionId === "string";
  });
}

async function setBindingIndex(ctx: PluginContext, entries: AcpBindingIndexEntry[]): Promise<void> {
  await ctx.state.set(indexLocator(), entries);
}

async function rememberBindingIndexEntry(ctx: PluginContext, entry: AcpBindingIndexEntry): Promise<void> {
  const entries = await getBindingIndex(ctx);
  if (entries.some((candidate) => candidate.acpSessionId === entry.acpSessionId)) return;
  entries.push(entry);
  await setBindingIndex(ctx, entries);
}

async function forgetBindingIndexEntry(ctx: PluginContext, acpSessionId: string): Promise<void> {
  const entries = await getBindingIndex(ctx);
  const filtered = entries.filter((entry) => entry.acpSessionId !== acpSessionId);
  if (filtered.length === entries.length) return;
  await setBindingIndex(ctx, filtered);
}

async function findBindingForSession(
  ctx: PluginContext,
  acpSessionId: string,
): Promise<AcpThreadBinding | null> {
  const entries = await getBindingIndex(ctx);
  for (const entry of entries) {
    if (entry.acpSessionId !== acpSessionId) continue;
    const raw = await ctx.state.get(bindingLocator(entry.companyId, acpSessionId));
    const binding = parseBinding(raw);
    if (binding) return binding;
  }
  return null;
}

export async function getAcpBinding(
  ctx: PluginContext,
  companyId: string,
  acpSessionId: string,
): Promise<AcpThreadBinding | null> {
  const raw = await ctx.state.get(bindingLocator(companyId, acpSessionId));
  return parseBinding(raw);
}

export type EmitAcpSpawnInput = {
  ctx: PluginContext;
  companyId: string;
  agentName: string;
  issueId: string;
  lineUserId: string;
  occurredAt: string;
};

/**
 * Generate an ACP session id, persist the binding so we can route output events
 * back to LINE, and emit `acp-spawn` on the bus. The ACP plugin uses the
 * sessionId we send as its session identifier.
 */
export async function emitAcpSpawn(input: EmitAcpSpawnInput): Promise<{ acpSessionId: string }> {
  const { ctx, companyId, agentName, issueId, lineUserId, occurredAt } = input;
  const acpSessionId = randomUUID();

  const binding: AcpThreadBinding = {
    version: ACP_BINDING_VERSION,
    acpSessionId,
    companyId,
    lineUserId,
    issueId,
    agentName,
    openedAt: occurredAt,
  };

  await ctx.state.set(bindingLocator(companyId, acpSessionId), binding);
  await rememberBindingIndexEntry(ctx, { companyId, acpSessionId });

  await ctx.events.emit(ACP_EVENT_NAMES.spawn, companyId, {
    sessionId: acpSessionId,
    agentName,
    chatId: lineUserId,
    threadId: issueId,
    companyId,
    mode: "persistent",
  });

  return { acpSessionId };
}

export async function emitAcpMessage(input: {
  ctx: PluginContext;
  companyId: string;
  acpSessionId: string;
  text: string;
}): Promise<void> {
  await input.ctx.events.emit(ACP_EVENT_NAMES.message, input.companyId, {
    sessionId: input.acpSessionId,
    text: input.text,
  });
}

export async function emitAcpClose(input: {
  ctx: PluginContext;
  companyId: string;
  acpSessionId: string;
}): Promise<void> {
  try {
    await input.ctx.events.emit(ACP_EVENT_NAMES.close, input.companyId, {
      sessionId: input.acpSessionId,
    });
  } finally {
    try {
      await input.ctx.state.delete(bindingLocator(input.companyId, input.acpSessionId));
    } catch (error) {
      input.ctx.logger.warn("Failed to delete ACP binding after close", {
        companyId: input.companyId,
        acpSessionId: input.acpSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await forgetBindingIndexEntry(input.ctx, input.acpSessionId);
  }
}

/**
 * Allow the worker to provide the LINE-push relay path. Kept as a registration
 * function rather than a constructor argument so acp-bridge.ts stays free of
 * worker.ts internals (and tests can stub the relay).
 */
export function setAcpRelayHandler(handler: AcpRelayHandler | null): void {
  registeredRelayHandler = handler;
}

export function getAcpRelayHandler(): AcpRelayHandler | null {
  return registeredRelayHandler;
}

type AcpOutputPayload = {
  sessionId: string;
  type: "text" | "tool_call" | "tool_result" | "error" | "done";
  text?: string;
  error?: string;
  platform?: string;
  threadId?: string;
};

function parseAcpOutputPayload(raw: unknown): AcpOutputPayload | null {
  const record = asRecord(raw);
  if (!record) return null;
  if (typeof record.sessionId !== "string" || typeof record.type !== "string") return null;
  const type = record.type as AcpOutputPayload["type"];
  if (!["text", "tool_call", "tool_result", "error", "done"].includes(type)) return null;
  return {
    sessionId: record.sessionId,
    type,
    text: typeof record.text === "string" ? record.text : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
    platform: typeof record.platform === "string" ? record.platform : undefined,
    threadId: typeof record.threadId === "string" ? record.threadId : undefined,
  };
}

export type AcpOutputObserver = (event: {
  payload: AcpOutputPayload;
  binding: AcpThreadBinding | null;
  relayed: boolean;
  dropReason?: "unknown_session" | "non_text" | "no_relay_handler" | "relay_failed";
}) => Promise<void> | void;

let outputObserver: AcpOutputObserver | null = null;

/**
 * Test seam. The worker doesn't use this; tests register an observer to assert
 * how output events are routed without needing to mock the LINE push pipeline.
 */
export function setAcpOutputObserver(observer: AcpOutputObserver | null): void {
  outputObserver = observer;
}

async function notifyObserver(input: Parameters<AcpOutputObserver>[0]): Promise<void> {
  const observer = outputObserver;
  if (!observer) return;
  try {
    await observer(input);
  } catch {
    // Observer failures must never block production output handling.
  }
}

export function registerAcpOutputListener(ctx: PluginContext): void {
  if (outputListenerRegistered) return;
  outputListenerRegistered = true;

  ctx.events.on(ACP_OUTPUT_EVENT, async (event) => {
    const payload = parseAcpOutputPayload(event.payload);
    if (!payload) return;

    const binding = await findBindingForSession(ctx, payload.sessionId);
    if (!binding) {
      await notifyObserver({ payload, binding: null, relayed: false, dropReason: "unknown_session" });
      return;
    }

    const isText = payload.type === "text" && typeof payload.text === "string" && payload.text.length > 0;
    const isError = payload.type === "error" && (typeof payload.error === "string" || typeof payload.text === "string");

    if (!isText && !isError) {
      await notifyObserver({ payload, binding, relayed: false, dropReason: "non_text" });
      return;
    }

    const handler = registeredRelayHandler;
    if (!handler) {
      await notifyObserver({ payload, binding, relayed: false, dropReason: "no_relay_handler" });
      return;
    }

    const text = isText
      ? (payload.text as string)
      : `Agent error: ${payload.error ?? payload.text ?? "unknown failure"}`;

    try {
      await handler({ binding, type: isText ? "text" : "error", text });
      await notifyObserver({ payload, binding, relayed: true });
    } catch (error) {
      ctx.logger.warn("Failed to relay ACP output to LINE", {
        acpSessionId: payload.sessionId,
        companyId: binding.companyId,
        lineUserId: binding.lineUserId,
        type: payload.type,
        error: error instanceof Error ? error.message : String(error),
      });
      await notifyObserver({ payload, binding, relayed: false, dropReason: "relay_failed" });
    }
  });
}

/** Test seam — clears module-level state between tests. */
export function resetAcpBridgeForTests(): void {
  registeredRelayHandler = null;
  outputObserver = null;
  outputListenerRegistered = false;
}

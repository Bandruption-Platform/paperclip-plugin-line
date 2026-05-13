import type { AgentSessionEvent, PluginContext } from "@paperclipai/plugin-sdk";
import { emitAcpClose, emitAcpMessage, emitAcpSpawn } from "./acp-bridge.js";
import { STATE_NAMESPACES, type ThreadSessionState } from "./constants.js";
import { withLock } from "./lock.js";

const SESSION_LOCK_PREFIX = "line-session";

export type SessionMode = "native" | "acp";
const ACP_AGENT_PREFIX = "acp:";

function isAcpSessionState(state: ThreadSessionState): boolean {
  return state.agentId.startsWith(ACP_AGENT_PREFIX);
}

function acpAgentMarker(agentName: string): string {
  return `${ACP_AGENT_PREFIX}${agentName}`;
}

type CloseThreadSessionInput = {
  ctx: PluginContext;
  companyId: string;
  issueId: string;
  closedAt: string;
  reason: string;
};

type DeliverLineTurnInput = {
  ctx: PluginContext;
  companyId: string;
  issueId: string;
  lineUserId: string;
  agentId: string;
  commentId: string;
  text: string;
  occurredAt: string;
  mode?: SessionMode;
  onEvent?: (event: AgentSessionEvent) => void;
};

export type DeliverLineTurnResult = {
  delivered: boolean;
  reopened: boolean;
  sessionId: string | null;
  reason: "created" | "reused" | "reopened" | "delivery_failed";
  mode: SessionMode;
};

function companySessionState(companyId: string, issueId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: STATE_NAMESPACES.sessions,
    stateKey: `session:${issueId}`,
  };
}

function normalizeSessionState(value: unknown): ThreadSessionState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Partial<ThreadSessionState>;
  if (
    typeof record.issueId !== "string" ||
    typeof record.lineUserId !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentId !== "string" ||
    (record.status !== "open" && record.status !== "closed") ||
    typeof record.openedAt !== "string" ||
    typeof record.lastActivityAt !== "string"
  ) {
    return null;
  }

  return {
    issueId: record.issueId,
    lineUserId: record.lineUserId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    status: record.status,
    openedAt: record.openedAt,
    lastActivityAt: record.lastActivityAt,
    lastCommentId: typeof record.lastCommentId === "string" ? record.lastCommentId : undefined,
    closedAt: typeof record.closedAt === "string" ? record.closedAt : undefined,
    closeReason: typeof record.closeReason === "string" ? record.closeReason : undefined,
  };
}

export async function getThreadSessionState(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
): Promise<ThreadSessionState | null> {
  const raw = await ctx.state.get(companySessionState(companyId, issueId));
  return normalizeSessionState(raw);
}

async function setThreadSessionState(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  value: ThreadSessionState,
): Promise<void> {
  await ctx.state.set(companySessionState(companyId, issueId), value);
}

function buildSessionPrompt(input: {
  issueId: string;
  commentId: string;
  lineUserId: string;
  text: string;
}): string {
  return [
    "New inbound LINE user message recorded on the current Paperclip issue thread.",
    `issue_id: ${input.issueId}`,
    `comment_id: ${input.commentId}`,
    `line_user_id: ${input.lineUserId}`,
    "",
    input.text,
  ].join("\n");
}

async function markClosed(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  existing: ThreadSessionState,
  closedAt: string,
  reason: string,
): Promise<ThreadSessionState> {
  const next: ThreadSessionState = {
    ...existing,
    status: "closed",
    closedAt,
    closeReason: reason,
    lastActivityAt: closedAt,
  };
  await setThreadSessionState(ctx, companyId, issueId, next);
  return next;
}

async function sendToNativeSession(input: DeliverLineTurnInput, sessionId: string): Promise<void> {
  await input.ctx.agents.sessions.sendMessage(sessionId, input.companyId, {
    prompt: buildSessionPrompt(input),
    reason: `Inbound LINE turn for issue ${input.issueId}`,
    onEvent: input.onEvent,
  });
}

async function closeRemoteNativeSessionBestEffort(
  input: Pick<DeliverLineTurnInput, "ctx" | "companyId" | "issueId">,
  sessionId: string,
): Promise<void> {
  try {
    await input.ctx.agents.sessions.close(sessionId, input.companyId);
  } catch (error) {
    input.ctx.logger.warn("Failed to close LINE thread session cleanly", {
      issueId: input.issueId,
      sessionId,
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function closeRemoteAcpSessionBestEffort(
  input: Pick<DeliverLineTurnInput, "ctx" | "companyId" | "issueId">,
  acpSessionId: string,
): Promise<void> {
  try {
    await emitAcpClose({
      ctx: input.ctx,
      companyId: input.companyId,
      acpSessionId,
    });
  } catch (error) {
    input.ctx.logger.warn("Failed to emit acp-close cleanly", {
      issueId: input.issueId,
      acpSessionId,
      companyId: input.companyId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function tearDownRemoteSession(
  input: Pick<DeliverLineTurnInput, "ctx" | "companyId" | "issueId">,
  existing: ThreadSessionState,
): Promise<void> {
  if (isAcpSessionState(existing)) {
    await closeRemoteAcpSessionBestEffort(input, existing.sessionId);
  } else {
    await closeRemoteNativeSessionBestEffort(input, existing.sessionId);
  }
}

export async function closeThreadSession(input: CloseThreadSessionInput): Promise<ThreadSessionState | null> {
  return withLock(`${SESSION_LOCK_PREFIX}:${input.issueId}`, async () => {
    const existing = await getThreadSessionState(input.ctx, input.companyId, input.issueId);
    if (!existing) return null;

    if (existing.status === "open") {
      await tearDownRemoteSession(input, existing);
    }

    return markClosed(
      input.ctx,
      input.companyId,
      input.issueId,
      existing,
      input.closedAt,
      input.reason,
    );
  });
}

export async function deliverLineTurnToSession(
  input: DeliverLineTurnInput,
): Promise<DeliverLineTurnResult> {
  const mode: SessionMode = input.mode ?? "native";
  const persistedAgentId = mode === "acp" ? acpAgentMarker(input.agentId) : input.agentId;

  return withLock(`${SESSION_LOCK_PREFIX}:${input.issueId}`, async () => {
    const existing = await getThreadSessionState(input.ctx, input.companyId, input.issueId);

    if (existing?.status === "open" && existing.agentId === persistedAgentId) {
      try {
        if (mode === "acp") {
          await emitAcpMessage({
            ctx: input.ctx,
            companyId: input.companyId,
            acpSessionId: existing.sessionId,
            text: input.text,
          });
        } else {
          await sendToNativeSession(input, existing.sessionId);
        }
        await setThreadSessionState(input.ctx, input.companyId, input.issueId, {
          ...existing,
          lastActivityAt: input.occurredAt,
          lastCommentId: input.commentId,
        });
        return {
          delivered: true,
          reopened: false,
          sessionId: existing.sessionId,
          reason: "reused",
          mode,
        };
      } catch (error) {
        input.ctx.logger.warn("LINE thread session send failed; reopening session", {
          issueId: input.issueId,
          sessionId: existing.sessionId,
          companyId: input.companyId,
          mode,
          error: error instanceof Error ? error.message : String(error),
        });
        await markClosed(
          input.ctx,
          input.companyId,
          input.issueId,
          existing,
          input.occurredAt,
          "session_send_failed",
        );
      }
    } else if (existing?.status === "open") {
      await tearDownRemoteSession(input, existing);
      await markClosed(
        input.ctx,
        input.companyId,
        input.issueId,
        existing,
        input.occurredAt,
        "agent_changed",
      );
    }

    let createdSessionId: string | null = null;
    try {
      if (mode === "acp") {
        const spawned = await emitAcpSpawn({
          ctx: input.ctx,
          companyId: input.companyId,
          agentName: input.agentId,
          issueId: input.issueId,
          lineUserId: input.lineUserId,
          occurredAt: input.occurredAt,
        });
        createdSessionId = spawned.acpSessionId;
        await emitAcpMessage({
          ctx: input.ctx,
          companyId: input.companyId,
          acpSessionId: createdSessionId,
          text: input.text,
        });
      } else {
        const session = await input.ctx.agents.sessions.create(input.agentId, input.companyId, {
          taskKey: `line-thread-${input.issueId}`,
          reason: `LINE thread session for issue ${input.issueId}`,
        });
        createdSessionId = session.sessionId;
        await sendToNativeSession(input, createdSessionId);
      }
    } catch (error) {
      if (typeof createdSessionId === "string") {
        if (mode === "acp") {
          await closeRemoteAcpSessionBestEffort(input, createdSessionId);
        } else {
          try {
            await input.ctx.agents.sessions.close(createdSessionId, input.companyId);
          } catch {
            // Best-effort cleanup after partial session creation.
          }
        }
      }
      input.ctx.logger.error("Failed to deliver LINE turn to agent session", {
        issueId: input.issueId,
        companyId: input.companyId,
        agentId: input.agentId,
        mode,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        delivered: false,
        reopened: Boolean(existing),
        sessionId: null,
        reason: "delivery_failed",
        mode,
      };
    }

    const sessionId = createdSessionId;
    await setThreadSessionState(input.ctx, input.companyId, input.issueId, {
      issueId: input.issueId,
      lineUserId: input.lineUserId,
      sessionId,
      agentId: persistedAgentId,
      status: "open",
      openedAt: input.occurredAt,
      lastActivityAt: input.occurredAt,
      lastCommentId: input.commentId,
    });

    return {
      delivered: true,
      reopened: Boolean(existing),
      sessionId,
      reason: existing ? "reopened" : "created",
      mode,
    };
  });
}

import type { AgentSessionEvent, PluginContext } from "@paperclipai/plugin-sdk";
import { STATE_NAMESPACES, type ThreadSessionState } from "./constants.js";
import { withLock } from "./lock.js";

const SESSION_LOCK_PREFIX = "line-session";

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
  onEvent?: (event: AgentSessionEvent) => void;
};

export type DeliverLineTurnResult = {
  delivered: boolean;
  reopened: boolean;
  sessionId: string | null;
  reason: "created" | "reused" | "reopened" | "delivery_failed";
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

async function sendToSession(input: DeliverLineTurnInput, sessionId: string): Promise<void> {
  await input.ctx.agents.sessions.sendMessage(sessionId, input.companyId, {
    prompt: buildSessionPrompt(input),
    reason: `Inbound LINE turn for issue ${input.issueId}`,
    onEvent: input.onEvent,
  });
}

async function closeRemoteSessionBestEffort(
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

export async function closeThreadSession(input: CloseThreadSessionInput): Promise<ThreadSessionState | null> {
  return withLock(`${SESSION_LOCK_PREFIX}:${input.issueId}`, async () => {
    const existing = await getThreadSessionState(input.ctx, input.companyId, input.issueId);
    if (!existing) return null;

    if (existing.status === "open") {
      await closeRemoteSessionBestEffort(input, existing.sessionId);
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
  return withLock(`${SESSION_LOCK_PREFIX}:${input.issueId}`, async () => {
    const existing = await getThreadSessionState(input.ctx, input.companyId, input.issueId);

    if (existing?.status === "open" && existing.agentId === input.agentId) {
      try {
        await sendToSession(input, existing.sessionId);
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
        };
      } catch (error) {
        input.ctx.logger.warn("LINE thread session send failed; reopening session", {
          issueId: input.issueId,
          sessionId: existing.sessionId,
          companyId: input.companyId,
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
      await closeRemoteSessionBestEffort(input, existing.sessionId);
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
      const session = await input.ctx.agents.sessions.create(input.agentId, input.companyId, {
        taskKey: `line-thread-${input.issueId}`,
        reason: `LINE thread session for issue ${input.issueId}`,
      });
      createdSessionId = session.sessionId;
      await sendToSession(input, createdSessionId);
    } catch (error) {
      if (typeof createdSessionId === "string") {
        try {
          await input.ctx.agents.sessions.close(createdSessionId, input.companyId);
        } catch {
          // Best-effort cleanup after partial session creation.
        }
      }
      input.ctx.logger.error("Failed to deliver LINE turn to agent session", {
        issueId: input.issueId,
        companyId: input.companyId,
        agentId: input.agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        delivered: false,
        reopened: Boolean(existing),
        sessionId: null,
        reason: "delivery_failed",
      };
    }

    const sessionId = createdSessionId;
    await setThreadSessionState(input.ctx, input.companyId, input.issueId, {
      issueId: input.issueId,
      lineUserId: input.lineUserId,
      sessionId,
      agentId: input.agentId,
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
    };
  });
}

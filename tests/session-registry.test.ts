import { describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import {
  closeThreadSession,
  deliverLineTurnToSession,
  getThreadSessionState,
} from "../src/session-registry.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";
const LINE_USER_ID = "line-user-1";
const AGENT_ID = "agent-1";

describe("session-registry generic agent delivery", () => {
  it("creates a new agent session on the first inbound turn", async () => {
    const harness = createTestHarness({ manifest });
    const createSpy = vi.spyOn(harness.ctx.agents.sessions, "create").mockResolvedValue({
      sessionId: "session-1",
    } as never);
    const sendSpy = vi
      .spyOn(harness.ctx.agents.sessions, "sendMessage")
      .mockResolvedValue(undefined as never);

    const result = await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_ID,
      commentId: "comment-1",
      text: "hello agent",
      occurredAt: new Date().toISOString(),
    });

    expect(result.delivered).toBe(true);
    expect(result.reason).toBe("created");
    expect(createSpy).toHaveBeenCalledWith(AGENT_ID, COMPANY_ID, expect.any(Object));
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const persisted = await getThreadSessionState(harness.ctx, COMPANY_ID, ISSUE_ID);
    expect(persisted).toMatchObject({
      sessionId: "session-1",
      agentId: AGENT_ID,
      status: "open",
      lineUserId: LINE_USER_ID,
    });
  });

  it("reuses an open session on subsequent turns for the same agent", async () => {
    const harness = createTestHarness({ manifest });
    vi.spyOn(harness.ctx.agents.sessions, "create").mockResolvedValue({
      sessionId: "session-2",
    } as never);
    const sendSpy = vi
      .spyOn(harness.ctx.agents.sessions, "sendMessage")
      .mockResolvedValue(undefined as never);

    await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_ID,
      commentId: "comment-1",
      text: "first",
      occurredAt: new Date().toISOString(),
    });

    const result = await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_ID,
      commentId: "comment-2",
      text: "second",
      occurredAt: new Date().toISOString(),
    });

    expect(result.delivered).toBe(true);
    expect(result.reason).toBe("reused");
    expect(result.sessionId).toBe("session-2");
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it("closes the existing session on closeThreadSession and updates state", async () => {
    const harness = createTestHarness({ manifest });
    vi.spyOn(harness.ctx.agents.sessions, "create").mockResolvedValue({
      sessionId: "session-3",
    } as never);
    vi.spyOn(harness.ctx.agents.sessions, "sendMessage").mockResolvedValue(undefined as never);
    const closeSpy = vi
      .spyOn(harness.ctx.agents.sessions, "close")
      .mockResolvedValue(undefined as never);

    await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_ID,
      commentId: "comment-1",
      text: "hi",
      occurredAt: new Date().toISOString(),
    });

    const closed = await closeThreadSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      closedAt: new Date().toISOString(),
      reason: "manual",
    });

    expect(closed?.status).toBe("closed");
    expect(closed?.closeReason).toBe("manual");
    expect(closeSpy).toHaveBeenCalledWith("session-3", COMPANY_ID);
  });
});

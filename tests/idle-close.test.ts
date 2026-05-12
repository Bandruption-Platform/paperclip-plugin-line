import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { JOB_KEYS, PRINCIPAL_STATUSES, STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin, { setExtensions } from "../src/worker.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";
const LINE_USER_ID = "line-user-1";
const AGENT_ID = "agent-1";

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function threadStateScope(lineUserId = LINE_USER_ID) {
  return {
    scopeKind: "company" as const,
    scopeId: COMPANY_ID,
    stateKey: `thread:${lineUserId}`,
  };
}

function threadSessionScope(issueId = ISSUE_ID) {
  return {
    scopeKind: "company" as const,
    scopeId: COMPANY_ID,
    namespace: STATE_NAMESPACES.sessions,
    stateKey: `session:${issueId}`,
  };
}

function threadIndexScope() {
  return {
    scopeKind: "instance" as const,
    namespace: STATE_NAMESPACES.threads,
    stateKey: STATE_KEYS.threadIndex,
  };
}

function principalScope(lineUserId = LINE_USER_ID) {
  return {
    scopeKind: "instance" as const,
    stateKey: `principal:${lineUserId}`,
  };
}

function seedIssue(harness: ReturnType<typeof createTestHarness>) {
  harness.seed({
    issues: [
      {
        id: ISSUE_ID,
        companyId: COMPANY_ID,
        status: "in_progress",
        title: "LINE thread",
      } as never,
    ],
  });
}

async function seedOpenThread(harness: ReturnType<typeof createTestHarness>, lastActivityAt: string) {
  harness.seed({
    agents: [
      {
        id: AGENT_ID,
        companyId: COMPANY_ID,
        name: "Helper",
        role: "agent",
        title: "Agent",
        status: "idle",
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never,
    ],
  });
  const session = await harness.ctx.agents.sessions.create(AGENT_ID, COMPANY_ID, {
    taskKey: `line-thread-${ISSUE_ID}`,
    reason: `LINE thread session for issue ${ISSUE_ID}`,
  });
  await harness.ctx.state.set(threadStateScope(), {
    paperclipIssueId: ISSUE_ID,
    status: "open",
    lastActivityAt,
    lastCommentId: "comment-1",
  });
  await harness.ctx.state.set(threadSessionScope(), {
    issueId: ISSUE_ID,
    lineUserId: LINE_USER_ID,
    sessionId: session.sessionId,
    agentId: AGENT_ID,
    status: "open",
    openedAt: minutesAgo(60),
    lastActivityAt,
    lastCommentId: "comment-1",
  });
  await harness.ctx.state.set(threadIndexScope(), [
    { companyId: COMPANY_ID, lineUserId: LINE_USER_ID },
  ]);
}

async function seedActivePrincipal(harness: ReturnType<typeof createTestHarness>) {
  await harness.ctx.state.set(principalScope(), {
    version: 1,
    lineUserId: LINE_USER_ID,
    displayName: "Display Name",
    pictureUrl: null,
    status: PRINCIPAL_STATUSES.active,
    linkedAt: new Date().toISOString(),
    paperclipCompany: COMPANY_ID,
    agentId: AGENT_ID,
  });
}

describe("idle close job", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    setExtensions({});
  });

  afterEach(() => {
    setExtensions({});
  });

  it("closes threads older than idleCloseMinutes", async () => {
    const harness = createTestHarness({
      manifest,
      config: { idleCloseMinutes: 30 },
    });
    await plugin.definition.setup(harness.ctx);
    seedIssue(harness);
    await seedOpenThread(harness, minutesAgo(35));

    await harness.runJob(JOB_KEYS.idleClose);

    expect(harness.getState(threadStateScope())).toMatchObject({
      paperclipIssueId: ISSUE_ID,
      status: "closed",
    });
    expect(harness.getState(threadSessionScope())).toMatchObject({
      status: "closed",
      closeReason: "idle",
    });
    expect(harness.metrics).toContainEqual({
      name: "line.idle_close.closed",
      value: 1,
      tags: { trigger: "manual" },
    });
  });

  it("leaves fresh threads alone", async () => {
    const harness = createTestHarness({
      manifest,
      config: { idleCloseMinutes: 30 },
    });
    await plugin.definition.setup(harness.ctx);
    seedIssue(harness);
    await seedOpenThread(harness, minutesAgo(10));

    await harness.runJob(JOB_KEYS.idleClose);

    expect(harness.getState(threadStateScope())).toMatchObject({
      paperclipIssueId: ISSUE_ID,
      status: "open",
    });
    const sessionState = harness.getState(threadSessionScope()) as { closeReason?: string };
    expect(sessionState).toMatchObject({
      status: "open",
    });
    expect(sessionState).not.toHaveProperty("closeReason");
    expect(harness.metrics).not.toContainEqual(
      expect.objectContaining({ name: "line.idle_close.closed" }),
    );
  });

  it("invokes the onCloseThread extension hook", async () => {
    const harness = createTestHarness({
      manifest,
      config: { idleCloseMinutes: 30 },
    });
    await plugin.definition.setup(harness.ctx);
    seedIssue(harness);
    await seedActivePrincipal(harness);
    await seedOpenThread(harness, minutesAgo(35));

    const onCloseThread = vi.fn(async () => undefined);
    setExtensions({ onCloseThread });

    await harness.runJob(JOB_KEYS.idleClose);

    expect(onCloseThread).toHaveBeenCalledTimes(1);
    expect(onCloseThread).toHaveBeenCalledWith({
      log: harness.ctx.logger,
      reason: "idle",
      principal: expect.objectContaining({
        lineUserId: LINE_USER_ID,
        paperclipCompany: COMPANY_ID,
      }),
    });
  });
});

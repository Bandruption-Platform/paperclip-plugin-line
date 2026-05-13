import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import {
  ACP_EVENT_NAMES,
  ACP_OUTPUT_EVENT,
  ACP_PLUGIN_ID,
  STATE_NAMESPACES,
  type AcpThreadBinding,
} from "../src/constants.js";
import {
  getAcpBinding,
  registerAcpOutputListener,
  resetAcpBridgeForTests,
  setAcpOutputObserver,
  setAcpRelayHandler,
  type AcpRelayHandler,
} from "../src/acp-bridge.js";
import {
  closeThreadSession,
  deliverLineTurnToSession,
  getThreadSessionState,
} from "../src/session-registry.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";
const LINE_USER_ID = "line-user-1";
const AGENT_NAME = "claude";

type EmitCall = { name: string; companyId: string; payload: Record<string, unknown> };

function captureEmits(harness: ReturnType<typeof createTestHarness>): EmitCall[] {
  const calls: EmitCall[] = [];
  vi.spyOn(harness.ctx.events, "emit").mockImplementation(
    async (name: string, companyId: string, payload: unknown) => {
      calls.push({ name, companyId, payload: (payload ?? {}) as Record<string, unknown> });
    },
  );
  return calls;
}

beforeEach(() => {
  resetAcpBridgeForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetAcpBridgeForTests();
});

describe("ACP bridge — outbound emission", () => {
  it("emits acp-spawn + acp-message and persists a binding on the first ACP-mode turn", async () => {
    const harness = createTestHarness({ manifest });
    const emits = captureEmits(harness);

    const result = await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-1",
      text: "hello claude",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });

    expect(result.delivered).toBe(true);
    expect(result.mode).toBe("acp");
    expect(result.reason).toBe("created");
    expect(typeof result.sessionId).toBe("string");

    const acpSessionId = result.sessionId as string;

    const spawnCall = emits.find((call) => call.name === ACP_EVENT_NAMES.spawn);
    expect(spawnCall).toBeDefined();
    expect(spawnCall?.companyId).toBe(COMPANY_ID);
    expect(spawnCall?.payload).toMatchObject({
      sessionId: acpSessionId,
      agentName: AGENT_NAME,
      chatId: LINE_USER_ID,
      threadId: ISSUE_ID,
      companyId: COMPANY_ID,
      mode: "persistent",
    });

    const messageCall = emits.find((call) => call.name === ACP_EVENT_NAMES.message);
    expect(messageCall?.payload).toEqual({ sessionId: acpSessionId, text: "hello claude" });

    const persistedSession = await getThreadSessionState(harness.ctx, COMPANY_ID, ISSUE_ID);
    expect(persistedSession).toMatchObject({
      sessionId: acpSessionId,
      agentId: `acp:${AGENT_NAME}`,
      status: "open",
      lineUserId: LINE_USER_ID,
    });

    const binding = await getAcpBinding(harness.ctx, COMPANY_ID, acpSessionId);
    expect(binding).toMatchObject({
      acpSessionId,
      companyId: COMPANY_ID,
      lineUserId: LINE_USER_ID,
      issueId: ISSUE_ID,
      agentName: AGENT_NAME,
    });
  });

  it("emits only acp-message (no second spawn) when reusing an open ACP session", async () => {
    const harness = createTestHarness({ manifest });
    const emits = captureEmits(harness);

    await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-1",
      text: "first",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });

    emits.length = 0;

    const result = await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-2",
      text: "second",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });

    expect(result.delivered).toBe(true);
    expect(result.reason).toBe("reused");
    expect(emits.some((call) => call.name === ACP_EVENT_NAMES.spawn)).toBe(false);
    expect(emits.filter((call) => call.name === ACP_EVENT_NAMES.message)).toHaveLength(1);
    expect(emits[0]?.payload).toMatchObject({ text: "second" });
  });

  it("emits acp-close (not agents.sessions.close) when an ACP-backed thread closes", async () => {
    const harness = createTestHarness({ manifest });
    const emits = captureEmits(harness);
    const sessionsCloseSpy = vi
      .spyOn(harness.ctx.agents.sessions, "close")
      .mockResolvedValue(undefined as never);

    await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-1",
      text: "hi",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });

    emits.length = 0;

    const closed = await closeThreadSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      closedAt: new Date().toISOString(),
      reason: "manual",
    });

    expect(closed?.status).toBe("closed");
    expect(closed?.agentId).toBe(`acp:${AGENT_NAME}`);
    expect(sessionsCloseSpy).not.toHaveBeenCalled();
    const closeCall = emits.find((call) => call.name === ACP_EVENT_NAMES.close);
    expect(closeCall).toBeDefined();
    expect(closeCall?.payload).toEqual({ sessionId: closed?.sessionId });

    const bindingAfter = await getAcpBinding(harness.ctx, COMPANY_ID, closed?.sessionId as string);
    expect(bindingAfter).toBeNull();
  });
});

describe("ACP bridge — inbound output relay", () => {
  it("relays text frames to the registered LINE push handler when the sessionId is known", async () => {
    const harness = createTestHarness({ manifest });
    captureEmits(harness);

    await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-1",
      text: "hi",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });

    const sessionState = await getThreadSessionState(harness.ctx, COMPANY_ID, ISSUE_ID);
    const acpSessionId = sessionState?.sessionId as string;

    const relayed: Array<Parameters<AcpRelayHandler>[0]> = [];
    setAcpRelayHandler(async (event) => {
      relayed.push(event);
    });
    registerAcpOutputListener(harness.ctx);

    await harness.emit(ACP_OUTPUT_EVENT, {
      sessionId: acpSessionId,
      type: "text",
      text: "hello back",
    });

    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.type).toBe("text");
    expect(relayed[0]?.text).toBe("hello back");
    expect(relayed[0]?.binding).toMatchObject({
      acpSessionId,
      lineUserId: LINE_USER_ID,
      agentName: AGENT_NAME,
    } satisfies Partial<AcpThreadBinding>);
  });

  it("drops output for unknown sessionIds without invoking the relay handler", async () => {
    const harness = createTestHarness({ manifest });

    const relayCalls: number[] = [];
    setAcpRelayHandler(async () => {
      relayCalls.push(1);
    });
    const observed: Array<{ relayed: boolean; dropReason?: string }> = [];
    setAcpOutputObserver((event) => {
      observed.push({ relayed: event.relayed, dropReason: event.dropReason });
    });
    registerAcpOutputListener(harness.ctx);

    await harness.emit(ACP_OUTPUT_EVENT, {
      sessionId: "ghost-session",
      type: "text",
      text: "nobody is listening",
    });

    expect(relayCalls).toHaveLength(0);
    expect(observed).toEqual([{ relayed: false, dropReason: "unknown_session" }]);
  });

  it("drops non-text frames (tool_call / tool_result / done) without relaying", async () => {
    const harness = createTestHarness({ manifest });
    captureEmits(harness);

    await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-1",
      text: "hi",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });
    const sessionState = await getThreadSessionState(harness.ctx, COMPANY_ID, ISSUE_ID);
    const acpSessionId = sessionState?.sessionId as string;

    const relayCalls: string[] = [];
    setAcpRelayHandler(async (event) => {
      relayCalls.push(event.type);
    });
    registerAcpOutputListener(harness.ctx);

    for (const type of ["tool_call", "tool_result", "done"] as const) {
      await harness.emit(ACP_OUTPUT_EVENT, {
        sessionId: acpSessionId,
        type,
        text: "should be ignored",
      });
    }

    expect(relayCalls).toHaveLength(0);
  });

  it("relays error frames using payload.error as the message", async () => {
    const harness = createTestHarness({ manifest });
    captureEmits(harness);

    await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-1",
      text: "hi",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });
    const sessionState = await getThreadSessionState(harness.ctx, COMPANY_ID, ISSUE_ID);
    const acpSessionId = sessionState?.sessionId as string;

    const relayed: Array<Parameters<AcpRelayHandler>[0]> = [];
    setAcpRelayHandler(async (event) => {
      relayed.push(event);
    });
    registerAcpOutputListener(harness.ctx);

    await harness.emit(ACP_OUTPUT_EVENT, {
      sessionId: acpSessionId,
      type: "error",
      error: "session crashed",
    });

    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.type).toBe("error");
    expect(relayed[0]?.text).toContain("session crashed");
  });
});

describe("ACP bridge — wiring sanity", () => {
  it("scopes the binding state under the acp namespace", async () => {
    const harness = createTestHarness({ manifest });
    captureEmits(harness);

    const result = await deliverLineTurnToSession({
      ctx: harness.ctx,
      companyId: COMPANY_ID,
      issueId: ISSUE_ID,
      lineUserId: LINE_USER_ID,
      agentId: AGENT_NAME,
      commentId: "comment-1",
      text: "hi",
      occurredAt: new Date().toISOString(),
      mode: "acp",
    });

    expect(STATE_NAMESPACES.acp).toBe("acp");
    expect(ACP_PLUGIN_ID).toBe("paperclip-plugin-acp");

    const acpSessionId = result.sessionId as string;
    const raw = harness.getState({
      scopeKind: "company",
      scopeId: COMPANY_ID,
      namespace: STATE_NAMESPACES.acp,
      stateKey: `binding:${acpSessionId}`,
    });
    expect(raw).toMatchObject({ acpSessionId, lineUserId: LINE_USER_ID });
  });
});

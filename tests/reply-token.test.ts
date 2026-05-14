import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import {
  JOB_KEYS,
  LINE_API,
  PRINCIPAL_STATUSES,
  STATE_KEYS,
  STATE_NAMESPACES,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin, { setExtensions } from "../src/worker.js";

const SECRET_REF = "line-secret-ref";
const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";
const LINE_USER_ID = "line-user-1";

function secondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function signLineBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

function buildBody(replyToken = "reply-token-1") {
  return JSON.stringify({
    events: [
      {
        type: "message",
        webhookEventId: `evt-${replyToken}`,
        timestamp: Date.now(),
        replyToken,
        source: { type: "user", userId: LINE_USER_ID },
        message: { type: "text", id: `msg-${replyToken}`, text: "hello" },
      },
    ],
  });
}

function commentMetaScope(commentId: string) {
  return {
    scopeKind: "company" as const,
    scopeId: COMPANY_ID,
    namespace: STATE_NAMESPACES.replyTokens,
    stateKey: `comment-meta:${commentId}`,
  };
}

function replyTokenIndexScope() {
  return {
    scopeKind: "instance" as const,
    namespace: STATE_NAMESPACES.replyTokens,
    stateKey: STATE_KEYS.commentMetaIndex,
  };
}

function threadStateScope() {
  return {
    scopeKind: "company" as const,
    scopeId: COMPANY_ID,
    stateKey: `thread:${LINE_USER_ID}`,
  };
}

function principalScope() {
  return {
    scopeKind: "instance" as const,
    stateKey: `principal:${LINE_USER_ID}`,
  };
}

function stubLineFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/bot/profile/")) {
        return new Response(
          JSON.stringify({
            displayName: "Display Name",
            pictureUrl: "https://example.com/p.png",
            language: "en",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === LINE_API.replyUrl) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function seedAgent(harness: ReturnType<typeof createTestHarness>) {
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

async function seedReplyToken(
  harness: ReturnType<typeof createTestHarness>,
  commentId: string,
  capturedAt: string,
) {
  await harness.ctx.state.set(commentMetaScope(commentId), {
    version: 1,
    lineUserId: LINE_USER_ID,
    lineMessageId: `msg-${commentId}`,
    replyToken: `reply-${commentId}`,
    capturedAt,
    usedAt: null,
  });
}

async function postWebhook(rawBody: string) {
  await plugin.definition.onWebhook?.({
    endpointKey: WEBHOOK_KEYS.lineWebhook,
    requestId: "req-1",
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers: {
      "x-line-signature": signLineBody(rawBody, `resolved:${SECRET_REF}`),
    },
  });
}

describe("reply-token cache", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    setExtensions({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setExtensions({});
  });

  it("caches inbound reply tokens and uses them for line.ack_with_reply_token", async () => {
    const calls = stubLineFetch();
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelSecretRef: SECRET_REF,
        lineChannelAccessTokenRef: "line-access-ref",
        defaultPaperclipCompany: COMPANY_ID,
        defaultAgentId: AGENT_ID,
      },
    });
    await plugin.definition.setup(harness.ctx);
    seedAgent(harness);

    const rawBody = buildBody("reply-token-1");
    await postWebhook(rawBody);
    await harness.runJob(JOB_KEYS.processEvent);

    const thread = harness.getState(threadStateScope()) as { lastCommentId?: string } | undefined;
    expect(thread?.lastCommentId).toEqual(expect.any(String));
    const commentId = thread?.lastCommentId ?? "";
    expect(harness.getState(commentMetaScope(commentId))).toMatchObject({
      lineUserId: LINE_USER_ID,
      replyToken: "reply-token-1",
    });

    const result = await harness.executeTool(
      TOOL_NAMES.ackWithReplyToken,
      { commentId, text: "acknowledged" },
      { companyId: COMPANY_ID, agentId: AGENT_ID },
    );

    expect(result.error).toBeUndefined();
    const replyCall = calls.find((call) => call.url === LINE_API.replyUrl);
    expect(replyCall).toBeDefined();
    expect(JSON.parse(String(replyCall?.init?.body))).toEqual({
      replyToken: "reply-token-1",
      messages: [{ type: "text", text: "acknowledged" }],
    });
    expect(harness.getState(commentMetaScope(commentId))).toBeUndefined();
  });

  it("returns reply_token_expired for expired cached tokens", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelAccessTokenRef: "line-access-ref",
        replyTokenMaxAgeSeconds: 60,
      },
    });
    await plugin.definition.setup(harness.ctx);
    await seedActivePrincipal(harness);
    await seedReplyToken(harness, "comment-expired", secondsAgo(90));
    await harness.ctx.state.set(replyTokenIndexScope(), [
      { companyId: COMPANY_ID, commentId: "comment-expired" },
    ]);

    const result = await harness.executeTool(
      TOOL_NAMES.ackWithReplyToken,
      { commentId: "comment-expired", text: "too late" },
      { companyId: COMPANY_ID, agentId: AGENT_ID },
    );

    expect(result).toEqual(expect.objectContaining({ error: "reply_token_expired" }));
    expect(harness.getState(commentMetaScope("comment-expired"))).toBeUndefined();
    expect(harness.metrics).toContainEqual({
      name: "line.reply_token.miss",
      value: 1,
      tags: { companyId: COMPANY_ID, reason: "expired" },
    });
  });

  it("removes expired cache entries in the reply-token-gc job", async () => {
    const harness = createTestHarness({
      manifest,
      config: { replyTokenMaxAgeSeconds: 60 },
    });
    await plugin.definition.setup(harness.ctx);
    await seedReplyToken(harness, "comment-fresh", secondsAgo(10));
    await seedReplyToken(harness, "comment-expired", secondsAgo(90));
    await harness.ctx.state.set(replyTokenIndexScope(), [
      { companyId: COMPANY_ID, commentId: "comment-fresh" },
      { companyId: COMPANY_ID, commentId: "comment-expired" },
    ]);

    await harness.runJob(JOB_KEYS.replyTokenGc);

    expect(harness.getState(commentMetaScope("comment-fresh"))).toMatchObject({
      replyToken: "reply-comment-fresh",
    });
    expect(harness.getState(commentMetaScope("comment-expired"))).toBeUndefined();
    expect(harness.getState(replyTokenIndexScope())).toEqual([
      { companyId: COMPANY_ID, commentId: "comment-fresh" },
    ]);
  });
});


import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { LINE_API, TOOL_NAMES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";
const LINE_USER_ID = "line-user-1";

async function seedActivePrincipal(harness: ReturnType<typeof createTestHarness>) {
  await harness.ctx.state.set(
    {
      scopeKind: "instance",
      stateKey: `principal:${LINE_USER_ID}`,
    },
    {
      version: 1,
      lineUserId: LINE_USER_ID,
      paperclipCompany: COMPANY_ID,
      agentId: AGENT_ID,
      displayName: "Friend",
      pictureUrl: null,
      status: "active",
      linkedAt: new Date().toISOString(),
    },
  );
}

function stubLinePushFetch(behavior: "ok" | "fail-4xx" | "network-error") {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === LINE_API.pushUrl) {
        if (behavior === "fail-4xx") {
          return new Response(JSON.stringify({ message: "bad request" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (behavior === "network-error") {
          throw new Error("connect ECONNREFUSED");
        }
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

describe("LINE push tools", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a push_text message for an in-scope principal", async () => {
    const calls = stubLinePushFetch("ok");
    const harness = createTestHarness({
      manifest,
      config: { lineChannelAccessTokenRef: "line-access-ref" },
    });
    await plugin.definition.setup(harness.ctx);
    await seedActivePrincipal(harness);

    const result = await harness.executeTool(
      TOOL_NAMES.pushText,
      { lineUserId: LINE_USER_ID, text: "hello" },
      { companyId: COMPANY_ID, agentId: AGENT_ID },
    );

    expect(result.error).toBeUndefined();
    expect(calls.filter((c) => c.url === LINE_API.pushUrl)).toHaveLength(1);
  });

  it("returns an error result when LINE replies 4xx", async () => {
    stubLinePushFetch("fail-4xx");
    const harness = createTestHarness({
      manifest,
      config: { lineChannelAccessTokenRef: "line-access-ref" },
    });
    await plugin.definition.setup(harness.ctx);
    await seedActivePrincipal(harness);

    await expect(
      harness.executeTool(
        TOOL_NAMES.pushText,
        { lineUserId: LINE_USER_ID, text: "hello" },
        { companyId: COMPANY_ID, agentId: AGENT_ID },
      ),
    ).rejects.toThrow(/LINE push failed with 400/);
  });

  it("propagates a network error from outbound fetch", async () => {
    stubLinePushFetch("network-error");
    const harness = createTestHarness({
      manifest,
      config: { lineChannelAccessTokenRef: "line-access-ref" },
    });
    await plugin.definition.setup(harness.ctx);
    await seedActivePrincipal(harness);

    await expect(
      harness.executeTool(
        TOOL_NAMES.pushText,
        { lineUserId: LINE_USER_ID, text: "hello" },
        { companyId: COMPANY_ID, agentId: AGENT_ID },
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it("returns line_push_daily_limit_exhausted when the budget is at capacity", async () => {
    stubLinePushFetch("ok");
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelAccessTokenRef: "line-access-ref",
        linePushDailyLimit: 1,
      },
    });
    await plugin.definition.setup(harness.ctx);
    await seedActivePrincipal(harness);

    const first = await harness.executeTool(
      TOOL_NAMES.pushText,
      { lineUserId: LINE_USER_ID, text: "first" },
      { companyId: COMPANY_ID, agentId: AGENT_ID },
    );
    expect(first.error).toBeUndefined();

    const second = await harness.executeTool(
      TOOL_NAMES.pushText,
      { lineUserId: LINE_USER_ID, text: "second" },
      { companyId: COMPANY_ID, agentId: AGENT_ID },
    );
    expect(second).toEqual(
      expect.objectContaining({
        error: "line_push_daily_limit_exhausted",
      }),
    );
  });

  it("rejects cross-company outbound sends before any LINE API call", async () => {
    const calls = stubLinePushFetch("ok");
    const harness = createTestHarness({
      manifest,
      config: { lineChannelAccessTokenRef: "line-access-ref" },
    });
    await plugin.definition.setup(harness.ctx);
    await seedActivePrincipal(harness);

    const result = await harness.executeTool(
      TOOL_NAMES.pushText,
      { lineUserId: LINE_USER_ID, text: "hi" },
      { companyId: "company-2", agentId: AGENT_ID },
    );
    expect(result.error).toBe("line_user_not_in_caller_scope");
    expect(calls).toHaveLength(0);
  });
});

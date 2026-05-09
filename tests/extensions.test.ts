import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { JOB_KEYS, LINE_API, PRINCIPAL_STATUSES, WEBHOOK_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin, { setExtensions } from "../src/worker.js";

const SECRET_REF = "line-secret-ref";
const LINE_USER_ID = "line-user-new";
const COMPANY_ID = "company-1";
const AGENT_ID = "agent-1";

function signLineBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

function buildBody(userId = LINE_USER_ID) {
  return JSON.stringify({
    events: [
      {
        type: "message",
        webhookEventId: `evt-${userId}`,
        timestamp: Date.now(),
        replyToken: "reply-1",
        source: { type: "user", userId },
        message: { type: "text", id: `msg-${userId}`, text: "hello" },
      },
    ],
  });
}

function stubLineApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.includes("/bot/profile/")) {
        return new Response(
          JSON.stringify({
            displayName: "Display Name",
            pictureUrl: "https://example.com/p.png",
            language: "ja",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === LINE_API.replyUrl || url === LINE_API.pushUrl) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }),
  );
}

async function seedAgent(harness: ReturnType<typeof createTestHarness>, companyId = COMPANY_ID, agentId = AGENT_ID) {
  harness.seed({
    agents: [
      {
        id: agentId,
        companyId,
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

async function postWebhook(rawBody: string) {
  await plugin.definition.onWebhook?.({
    endpointKey: WEBHOOK_KEYS.lineWebhook,
    requestId: `req-${Math.random()}`,
    rawBody,
    parsedBody: JSON.parse(rawBody),
    headers: {
      "x-line-signature": signLineBody(rawBody, `resolved:${SECRET_REF}`),
    },
  });
}

describe("extension hooks", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
    setExtensions({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setExtensions({});
  });

  it("falls back to defaultPaperclipCompany / defaultAgentId when no hook is registered", async () => {
    stubLineApi();
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
    await seedAgent(harness);

    await postWebhook(buildBody());
    await harness.runJob(JOB_KEYS.processEvent, { trigger: "manual" });

    const principal = await harness.ctx.state.get({
      scopeKind: "instance",
      stateKey: `principal:${LINE_USER_ID}`,
    });
    expect(principal).toMatchObject({
      status: PRINCIPAL_STATUSES.active,
      paperclipCompany: COMPANY_ID,
      agentId: AGENT_ID,
    });
  });

  it("invokes onProvisionPrincipal when registered and uses its mapping", async () => {
    stubLineApi();
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelSecretRef: SECRET_REF,
        lineChannelAccessTokenRef: "line-access-ref",
      },
    });
    await plugin.definition.setup(harness.ctx);
    await seedAgent(harness, "tenant-co", "tenant-agent");

    const hook = vi.fn(async () => ({
      paperclipCompany: "tenant-co",
      agentId: "tenant-agent",
      preferredLocale: "en-GB",
      metadata: { tenantId: "t-42" },
    }));
    setExtensions({ onProvisionPrincipal: hook });

    await postWebhook(buildBody());
    await harness.runJob(JOB_KEYS.processEvent, { trigger: "manual" });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ paperclipApiBaseUrl: expect.any(String) }),
        profile: expect.objectContaining({ language: "ja" }),
      }),
      LINE_USER_ID,
    );

    const principal = await harness.ctx.state.get({
      scopeKind: "instance",
      stateKey: `principal:${LINE_USER_ID}`,
    });
    expect(principal).toMatchObject({
      status: PRINCIPAL_STATUSES.active,
      paperclipCompany: "tenant-co",
      agentId: "tenant-agent",
      preferredLocale: "en-GB",
      metadata: { tenantId: "t-42" },
    });
  });

  it("falls back to defaults when the hook returns null", async () => {
    stubLineApi();
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
    await seedAgent(harness);

    const hook = vi.fn(async () => null);
    setExtensions({ onProvisionPrincipal: hook });

    await postWebhook(buildBody());
    await harness.runJob(JOB_KEYS.processEvent, { trigger: "manual" });

    expect(hook).toHaveBeenCalledTimes(1);
    // Hook returned null => no principal is provisioned at all (the public
    // contract says null means "drop event"). Defaults are NOT used as a
    // fallback in that case; that ambiguity is documented in the README.
    const principal = await harness.ctx.state.get({
      scopeKind: "instance",
      stateKey: `principal:${LINE_USER_ID}`,
    });
    expect(principal).toBeNull();
  });

  it("drops the event and increments dropped_unmapped when neither hook nor defaults are configured", async () => {
    stubLineApi();
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelSecretRef: SECRET_REF,
        lineChannelAccessTokenRef: "line-access-ref",
      },
    });
    await plugin.definition.setup(harness.ctx);

    await postWebhook(buildBody());
    await harness.runJob(JOB_KEYS.processEvent, { trigger: "manual" });

    const principal = await harness.ctx.state.get({
      scopeKind: "instance",
      stateKey: `principal:${LINE_USER_ID}`,
    });
    expect(principal).toBeNull();

    const droppedMetric = harness.metrics.find(
      (metric) => metric.name === "line.webhook.dropped_unmapped",
    );
    expect(droppedMetric).toBeDefined();
  });

  it("calls onCloseThread when a thread is closed", async () => {
    stubLineApi();
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelSecretRef: SECRET_REF,
        lineChannelAccessTokenRef: "line-access-ref",
        defaultPaperclipCompany: COMPANY_ID,
        defaultAgentId: AGENT_ID,
        idleCloseMinutes: 1,
      },
    });
    await plugin.definition.setup(harness.ctx);
    await seedAgent(harness);

    const closeHook = vi.fn(async () => undefined);
    setExtensions({ onCloseThread: closeHook });

    await postWebhook(buildBody());
    await harness.runJob(JOB_KEYS.processEvent, { trigger: "manual" });

    // Manually invoke the close-thread tool to trigger the hook.
    const result = await harness.executeTool(
      "line.close_thread",
      { lineUserId: LINE_USER_ID },
      { companyId: COMPANY_ID, agentId: AGENT_ID },
    );
    expect(result.error).toBeUndefined();
    expect(closeHook).toHaveBeenCalledTimes(1);
    expect(closeHook).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: "tool_close",
        principal: expect.objectContaining({
          paperclipCompany: COMPANY_ID,
          agentId: AGENT_ID,
        }),
      }),
    );
  });
});

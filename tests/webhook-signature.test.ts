import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { WEBHOOK_KEYS } from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const SECRET_REF = "line-secret-ref";
const LINE_USER_ID = "line-user-1";

function signLineBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

function buildBody() {
  return JSON.stringify({
    events: [
      {
        type: "message",
        webhookEventId: "evt-1",
        timestamp: Date.now(),
        replyToken: "reply-1",
        source: { type: "user", userId: LINE_USER_ID },
        message: { type: "text", id: "msg-1", text: "hi" },
      },
    ],
  });
}

describe("LINE webhook signature verification", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a request whose x-line-signature matches the channel secret", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelSecretRef: SECRET_REF,
        defaultPaperclipCompany: "company-1",
        defaultAgentId: "agent-1",
      },
    });
    await plugin.definition.setup(harness.ctx);

    const rawBody = buildBody();
    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: WEBHOOK_KEYS.lineWebhook,
        requestId: "req-1",
        rawBody,
        parsedBody: JSON.parse(rawBody),
        headers: {
          "x-line-signature": signLineBody(rawBody, `resolved:${SECRET_REF}`),
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a request with a mismatched signature", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelSecretRef: SECRET_REF,
        defaultPaperclipCompany: "company-1",
        defaultAgentId: "agent-1",
      },
    });
    await plugin.definition.setup(harness.ctx);

    const rawBody = buildBody();
    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: WEBHOOK_KEYS.lineWebhook,
        requestId: "req-2",
        rawBody,
        parsedBody: JSON.parse(rawBody),
        headers: {
          "x-line-signature": signLineBody(rawBody, "the-wrong-secret"),
        },
      }),
    ).rejects.toMatchObject({
      code: 401,
      message: expect.stringContaining("Invalid LINE webhook signature"),
    });
  });

  it("rejects a request that is missing the signature header", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        lineChannelSecretRef: SECRET_REF,
        defaultPaperclipCompany: "company-1",
        defaultAgentId: "agent-1",
      },
    });
    await plugin.definition.setup(harness.ctx);

    const rawBody = buildBody();
    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: WEBHOOK_KEYS.lineWebhook,
        requestId: "req-3",
        rawBody,
        parsedBody: JSON.parse(rawBody),
        headers: {},
      }),
    ).rejects.toMatchObject({
      code: 401,
      message: expect.stringContaining("Invalid LINE webhook signature"),
    });
  });

  it("rejects a request when the channel secret reference is unset", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        defaultPaperclipCompany: "company-1",
        defaultAgentId: "agent-1",
      },
    });
    await plugin.definition.setup(harness.ctx);

    const rawBody = buildBody();
    await expect(
      plugin.definition.onWebhook?.({
        endpointKey: WEBHOOK_KEYS.lineWebhook,
        requestId: "req-4",
        rawBody,
        parsedBody: JSON.parse(rawBody),
        headers: {
          "x-line-signature": signLineBody(rawBody, "anything"),
        },
      }),
    ).rejects.toMatchObject({
      code: 401,
      message: expect.stringContaining("lineChannelSecretRef is not configured"),
    });
  });
});

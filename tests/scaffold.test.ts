import { describe, expect, it } from "vitest";
import {
  JOB_KEYS,
  PLUGIN_ID,
  PLUGIN_VERSION,
  TOOL_NAMES,
  WEBHOOK_KEYS,
} from "../src/constants.js";
import manifest from "../src/manifest.js";

describe("paperclip-plugin-line manifest", () => {
  it("declares the public plugin identity", () => {
    expect(manifest.id).toBe(PLUGIN_ID);
    expect(manifest.id).toBe("line-bridge");
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.description).toContain("verified webhook intake");
  });

  it("exposes the expected capability set", () => {
    expect(manifest.capabilities).toEqual(
      expect.arrayContaining([
        "plugin.state.read",
        "plugin.state.write",
        "jobs.schedule",
        "webhooks.receive",
        "agent.tools.register",
        "http.outbound",
        "secrets.read-ref",
        "activity.log.write",
        "metrics.write",
        "issues.read",
        "issues.create",
        "issues.update",
        "issue.comments.read",
        "issue.comments.create",
        "agents.read",
        "agent.sessions.create",
        "agent.sessions.list",
        "agent.sessions.send",
        "agent.sessions.close",
      ]),
    );
  });

  it("declares only the public-facing webhook endpoint", () => {
    const endpoints = (manifest.webhooks ?? []).map((webhook) => webhook.endpointKey);
    expect(endpoints).toEqual([WEBHOOK_KEYS.lineWebhook]);
    expect(endpoints).not.toContain("line-link");
  });

  it("declares the expected job set", () => {
    expect((manifest.jobs ?? []).map((job) => job.jobKey)).toEqual([
      JOB_KEYS.processEvent,
      JOB_KEYS.idleClose,
      JOB_KEYS.replyTokenGc,
    ]);
  });

  it("declares the eight outbound LINE tools", () => {
    expect((manifest.tools ?? []).map((tool) => tool.name)).toEqual([
      TOOL_NAMES.pushText,
      TOOL_NAMES.pushImage,
      TOOL_NAMES.pushFlex,
      TOOL_NAMES.pushTemplate,
      TOOL_NAMES.pushSticker,
      TOOL_NAMES.ackWithReplyToken,
      TOOL_NAMES.closeThread,
      TOOL_NAMES.getProfile,
    ]);
  });

  it("exposes default-mapping config fields and excludes stripped fields", () => {
    const properties = (manifest.instanceConfigSchema?.properties ?? {}) as Record<string, unknown>;
    expect(properties).toHaveProperty("defaultPaperclipCompany");
    expect(properties).toHaveProperty("defaultAgentId");
    expect(properties).not.toHaveProperty("lineLinkSigningSecretRef");
    expect(properties).not.toHaveProperty("lineLinkPlatformServiceSecretRef");
    expect(properties).not.toHaveProperty("flagshipMcpUrl");
    expect(properties).not.toHaveProperty("flagshipAgentTokenSeedRef");
    expect(properties).not.toHaveProperty("githubEscalationTokenSeedRef");
    expect(properties).not.toHaveProperty("defaultArtistBudgetMonthlyCents");
    expect(properties).not.toHaveProperty("linkTokenTtlSeconds");
  });
});

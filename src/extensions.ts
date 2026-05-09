/**
 * Extension hooks for paperclip-plugin-line.
 *
 * The plugin runs out of the box in single-tenant mode: every inbound LINE
 * userId maps to one configured Paperclip company and one configured agent
 * (`defaultPaperclipCompany` + `defaultAgentId` in instance config).
 *
 * To run multi-tenant — for example, mapping LINE users to per-customer
 * Paperclip companies via your own identity flow — provide an
 * `onProvisionPrincipal` hook. The hook is invoked the first time the
 * plugin sees an unmapped LINE userId. Return a `paperclipCompany` +
 * `agentId` binding to provision the user; return `null` to silently drop
 * the event.
 *
 * Hooks run inside the plugin's normal capability set; they cannot
 * escalate. Hooks must be idempotent — they may be called more than once
 * for the same userId during retries.
 *
 * Register your extensions when packaging a downstream fork, or import
 * this plugin and pass them via the SDK's plugin loader. See the README
 * for examples.
 */

import type { PrincipalState } from "./constants.js";

export interface ProvisionPrincipalContext {
  /** Plugin-installation-scoped logger. */
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Resolved instance config for the active install. */
  config: {
    defaultPaperclipCompany: string;
    defaultAgentId: string;
    paperclipApiBaseUrl: string;
  };
  /** Optional LINE profile data fetched immediately before this hook fires. */
  profile: {
    displayName: string | null;
    pictureUrl: string | null;
    statusMessage: string | null;
    language: string | null;
  } | null;
}

export interface ProvisionPrincipalResult {
  paperclipCompany: string;
  agentId: string;
  /**
   * Optional. Override the principal's preferred locale tag (BCP-47).
   * Defaults to LINE profile `language` when not set.
   */
  preferredLocale?: string;
  /**
   * Optional. Plugin-private metadata attached to the principal record.
   * Useful for downstream forks that need to remember a customer ID,
   * tenant ID, or external mapping key alongside the LINE userId.
   */
  metadata?: Record<string, string>;
}

export interface CloseThreadContext {
  log: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  reason: "idle" | "tool_close" | "manual";
  principal: PrincipalState;
}

export interface LineBridgeExtensions {
  /**
   * Called when an inbound LINE event arrives from a userId not yet mapped
   * to a Paperclip principal. Return a binding to provision the user, or
   * `null` to silently acknowledge the event without provisioning.
   *
   * If this hook is not supplied and the install does not have
   * `defaultPaperclipCompany` / `defaultAgentId` configured, inbound
   * events from new userIds are dropped (and counted in
   * `line.webhook.dropped_unmapped`).
   */
  onProvisionPrincipal?: (
    ctx: ProvisionPrincipalContext,
    lineUserId: string,
  ) => Promise<ProvisionPrincipalResult | null>;

  /**
   * Optional. Called when the plugin closes a LINE thread (idle sweep, the
   * `line.close_thread` tool, or operator action). Use to clean up
   * downstream state in your fork.
   */
  onCloseThread?: (ctx: CloseThreadContext) => Promise<void>;
}

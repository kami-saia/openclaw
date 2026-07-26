import type { AgentMessage } from "@mariozechner/pi-ai";
// FORK: Coverage for served-model resolution feeding the Runtime line's
// `served_model=` token. buildRuntimeLine tests only cover rendering; these
// cover the logic that decides WHAT gets rendered, which is where the real
// failure modes live (wrong field name, wrong role, wrong scan direction).
import { describe, expect, it } from "vitest";
import { resolveLastServedModel } from "./attempt.ts";

function assistant(responseModel?: unknown): AgentMessage {
  return {
    role: "assistant",
    content: [],
    ...(responseModel === undefined ? {} : { responseModel }),
  } as unknown as AgentMessage;
}

function user(): AgentMessage {
  return { role: "user", content: [] } as unknown as AgentMessage;
}

describe("resolveLastServedModel", () => {
  it("returns undefined for empty or missing transcripts", () => {
    expect(resolveLastServedModel(undefined)).toBeUndefined();
    expect(resolveLastServedModel([])).toBeUndefined();
  });

  it("reads the provider-reported served model off an assistant message", () => {
    expect(resolveLastServedModel([assistant("claude-opus-4-8")])).toBe("claude-opus-4-8");
  });

  // Guards the exact trap that would silently disable this feature: the on-disk
  // transcript field is `responseModel`, NOT `responseModelId`. If an upstream
  // rename lands, this fails loudly instead of returning undefined forever.
  it("does not read responseModelId", () => {
    const wrongField = {
      role: "assistant",
      content: [],
      responseModelId: "claude-opus-4-8",
    } as unknown as AgentMessage;
    expect(resolveLastServedModel([wrongField])).toBeUndefined();
  });

  it("prefers the most recent assistant message (scans backwards)", () => {
    const messages = [assistant("claude-opus-4-8"), user(), assistant("claude-opus-5")];
    expect(resolveLastServedModel(messages)).toBe("claude-opus-5");
  });

  it("skips assistant messages with no served model and keeps scanning", () => {
    const messages = [assistant("claude-opus-5"), assistant(undefined)];
    expect(resolveLastServedModel(messages)).toBe("claude-opus-5");
  });

  it("skips empty and whitespace-only values", () => {
    expect(resolveLastServedModel([assistant("claude-opus-5"), assistant("   ")])).toBe(
      "claude-opus-5",
    );
    expect(resolveLastServedModel([assistant("")])).toBeUndefined();
  });

  it("ignores non-assistant roles even when they carry the field", () => {
    const spoofedUser = {
      role: "user",
      content: [],
      responseModel: "not-a-real-model",
    } as unknown as AgentMessage;
    expect(resolveLastServedModel([spoofedUser])).toBeUndefined();
  });

  it("ignores non-string values", () => {
    expect(resolveLastServedModel([assistant(42)])).toBeUndefined();
    expect(resolveLastServedModel([assistant(null)])).toBeUndefined();
  });

  // The whole point of the feature: a divergence must be recoverable so the
  // Runtime line can show requested vs served side by side.
  it("surfaces a served model that diverges from the requested one", () => {
    expect(resolveLastServedModel([assistant("claude-opus-4-8")])).toBe("claude-opus-4-8");
  });
});

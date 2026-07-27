import type { AgentMessage } from "@mariozechner/pi-ai";
// FORK: Coverage for served-model resolution feeding the Runtime line's
// `served_model=` token. buildRuntimeLine tests only cover rendering; these
// cover the logic that decides WHAT gets rendered, which is where the real
// failure modes live (wrong field name, wrong role, wrong scan direction).
import { describe, expect, it } from "vitest";
import { resolveDivergentServedModel, resolveLastServedModel } from "./attempt.ts";

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

// FORK: `served_model=` is only worth rendering when it disagrees with the
// requested model. Rendering it on every turn changed the system prompt digest
// and dropped the provider prompt cache each turn for zero information gain.
describe("resolveDivergentServedModel", () => {
  it("returns undefined when no served model is recoverable", () => {
    expect(
      resolveDivergentServedModel({ messages: [], requestedModel: "github-copilot/claude-opus-5" }),
    ).toBeUndefined();
  });

  it("returns undefined when served matches the requested model", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistant("claude-opus-5")],
        requestedModel: "github-copilot/claude-opus-5",
      }),
    ).toBeUndefined();
  });

  // Requested labels spell versions with dots (`claude-opus-4.8`) while providers
  // report dashes (`claude-opus-4-8`). Without normalization every single turn
  // would look like a swap.
  it("treats dot and dash version spellings as the same model", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistant("claude-opus-4-8")],
        requestedModel: "github-copilot/claude-opus-4.8",
      }),
    ).toBeUndefined();
  });

  it("ignores case differences", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistant("Claude-Opus-5")],
        requestedModel: "github-copilot/claude-opus-5",
      }),
    ).toBeUndefined();
  });

  it("surfaces a real swap", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistant("claude-opus-4-8")],
        requestedModel: "github-copilot/claude-opus-5",
      }),
    ).toBe("claude-opus-4-8");
  });

  it("surfaces the served model when the requested one is unknown", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistant("claude-opus-5")],
        requestedModel: undefined,
      }),
    ).toBe("claude-opus-5");
  });

  it("compares against the most recent assistant turn", () => {
    const messages = [assistant("claude-opus-4-8"), user(), assistant("claude-opus-5")];
    expect(
      resolveDivergentServedModel({
        messages,
        requestedModel: "github-copilot/claude-opus-5",
      }),
    ).toBeUndefined();
  });
});

// FORK: Coverage for served-model resolution feeding the Runtime line's
// `served_model=` token. buildRuntimeLine tests only cover rendering; these
// cover the logic that decides WHAT gets rendered, which is where the real
// failure modes live (wrong field name, wrong role, wrong scan direction).
import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../runtime/index.js";
import { resolveDivergentServedModel, resolveLastServedModel } from "./attempt.ts";

function assistant(responseModel?: unknown): AgentMessage {
  return {
    role: "assistant",
    content: [],
    ...(responseModel === undefined ? {} : { responseModel }),
  } as unknown as AgentMessage;
}

function assistantFor(model: string, responseModel?: string): AgentMessage {
  return {
    role: "assistant",
    content: [],
    model,
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
  const requestedModel = "***/claude-opus-5";

  it("returns undefined when no served model is recoverable", () => {
    expect(resolveDivergentServedModel({ messages: [], requestedModel })).toBeUndefined();
  });

  it("returns undefined when served matches the requested model", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistantFor("claude-opus-5", "claude-opus-5")],
        requestedModel,
      }),
    ).toBeUndefined();
  });

  // Requested labels spell versions with dots (`claude-opus-4.8`) while providers
  // report dashes (`claude-opus-4-8`). Without normalization every single turn
  // would look like a swap.
  it("treats dot and dash version spellings as the same model", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistantFor("claude-opus-4.8", "claude-opus-4-8")],
        requestedModel: "***/claude-opus-4.8",
      }),
    ).toBeUndefined();
  });

  it("ignores case differences", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistantFor("claude-opus-5", "Claude-Opus-5")],
        requestedModel,
      }),
    ).toBeUndefined();
  });

  it("surfaces a real swap", () => {
    expect(
      resolveDivergentServedModel({
        messages: [assistantFor("claude-opus-5", "claude-opus-4-8")],
        requestedModel,
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

  // 2026-10-10 regression: an exec-completion wake ran on heartbeat.model
  // (Sonnet) inside an Opus session. Its message was the newest one, so the
  // next Opus turn rendered `served_model=claude-sonnet-5-5` — a phantom swap.
  it("ignores a newer heartbeat-model wake turn that requested a different model", () => {
    const messages = [
      assistantFor("claude-opus-5", "claude-opus-5"),
      user(),
      assistantFor("claude-sonnet-5.5", "claude-sonnet-5-5"),
    ];
    expect(resolveDivergentServedModel({ messages, requestedModel })).toBeUndefined();
  });

  it("does not flag the turns from before a /model switch", () => {
    const messages = [assistantFor("claude-opus-4.8", "claude-opus-4-8")];
    expect(resolveDivergentServedModel({ messages, requestedModel })).toBeUndefined();
  });

  it("still catches a swap behind a newer wake turn", () => {
    const messages = [
      assistantFor("claude-opus-5", "claude-opus-4-8"),
      user(),
      assistantFor("claude-sonnet-5.5", "claude-sonnet-5-5"),
    ];
    expect(resolveDivergentServedModel({ messages, requestedModel })).toBe("claude-opus-4-8");
  });

  it("reads the newest matching turn, not an older swapped one", () => {
    const messages = [
      assistantFor("claude-opus-5", "claude-opus-4-8"),
      user(),
      assistantFor("claude-opus-5", "claude-opus-5"),
    ];
    expect(resolveDivergentServedModel({ messages, requestedModel })).toBeUndefined();
  });

  it("treats a matching turn without responseModel as served as requested", () => {
    const messages = [
      assistantFor("claude-opus-5", "claude-opus-4-8"),
      assistantFor("claude-opus-5"),
    ];
    expect(resolveDivergentServedModel({ messages, requestedModel })).toBeUndefined();
  });
});

/**
 * FORK: Provider-reported "served model" resolution feeding the Runtime line's
 * `served_model=` token.
 *
 * Lives in its own module (rather than in attempt.ts, where it originated) so
 * that attempt-session-runtime-prepare.ts can consume it without creating an
 * import cycle: attempt.ts -> attempt-session-runtime-prepare.ts -> here.
 */
import type { AgentMessage } from "../../runtime/index.js";

// FORK: Resolve the provider-reported *served* model by scanning the restored
// in-memory transcript backwards for the most recent assistant message that
// carries a non-empty `responseModel`. A one-turn lag is expected because the
// current turn's served model is unknowable before the model call. Pure,
// synchronous, and reads only the array already in memory (no disk IO/async).
export function resolveLastServedModel(messages: AgentMessage[] | undefined): string | undefined {
  if (!messages?.length) {
    return undefined;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") {
      continue;
    }
    const served = (message as unknown as { responseModel?: unknown }).responseModel;
    if (typeof served === "string" && served.trim().length > 0) {
      return served;
    }
  }
  return undefined;
}

// FORK: The requested label is `provider/model-id` while the provider reports a
// bare model slug, and the two spell versions differently (`claude-opus-4.8` vs
// `claude-opus-4-8`). Normalize both sides so an identical model does not read as
// a divergence.
function normalizeModelLabelForComparison(label: string): string {
  const bare = label.includes("/") ? label.slice(label.lastIndexOf("/") + 1) : label;
  return bare.trim().toLowerCase().replaceAll(".", "-");
}

// FORK: `served_model=` exists to make a SILENT provider swap visible. When the
// served model matches the requested one — the overwhelmingly common case — the
// token adds nothing and re-rendering the system prompt to inject it only churns
// the prompt digest, which invalidates the provider prompt cache every turn.
// Report a divergence only.
export function resolveDivergentServedModel(params: {
  messages: AgentMessage[] | undefined;
  requestedModel: string | undefined;
}): string | undefined {
  const served = resolveLastServedModel(params.messages);
  if (!served) {
    return undefined;
  }
  const requested = params.requestedModel;
  if (!requested) {
    return served;
  }
  return normalizeModelLabelForComparison(requested) === normalizeModelLabelForComparison(served)
    ? undefined
    : served;
}

import { resolveAnthropicServerCompactionPlan } from "@openclaw/ai/internal/anthropic";
import { resolveOpenAIResponsesServerCompactionPlan } from "@openclaw/ai/internal/openai-responses-payload-policy";
import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { estimateMessagesTokens } from "../../agents/compaction.js";
import { resolveModelExtraParamSources } from "../../agents/model-extra-params.js";
import { normalizeStaticProviderModelId } from "../../agents/model-ref-shared.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import {
  findConfiguredProviderModel,
  resolveMergedModelProviderConfig,
} from "../../config/model-provider-config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { TranscriptTokenEstimate } from "./agent-runner-memory-transcript-context.js";

function resolveEffectivePromptTokens(
  basePromptTokens?: number,
  lastOutputTokens?: number,
  promptTokenEstimate?: number,
): number {
  const base = Math.max(0, basePromptTokens ?? 0);
  const output = Math.max(0, lastOutputTokens ?? 0);
  const estimate = Math.max(0, promptTokenEstimate ?? 0);
  // Flush gating projects the next input context by adding the previous
  // completion and the current user prompt estimate.
  return base + output + estimate;
}

export function resolveProjectedPromptTokens(
  persistedPromptTokens: number | undefined,
  promptTokenEstimate: number | undefined,
  transcript: TranscriptTokenEstimate | undefined,
): number {
  const project = (promptTokens: number | undefined, outputTokens: number | undefined) =>
    promptTokens !== undefined
      ? resolveEffectivePromptTokens(promptTokens, outputTokens, promptTokenEstimate)
      : 0;
  return Math.max(
    project(persistedPromptTokens, transcript?.outputTokens),
    project(
      transcript?.promptTokens,
      transcript?.promptIncludesOutput ? undefined : transcript?.outputTokens,
    ),
  );
}

export function estimatePromptTokensForMemoryFlush(prompt?: string): number | undefined {
  const trimmed = normalizeOptionalString(prompt);
  if (!trimmed) {
    return undefined;
  }
  const message: AgentMessage = { role: "user", content: trimmed, timestamp: Date.now() };
  return Math.ceil(estimateMessagesTokens([message]));
}

export function resolveCompactionThreshold(params: {
  contextWindowTokens: number;
  reserveTokensFloor: number;
  minimumThresholdTokens?: number;
}): number {
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  return Math.max(0, contextWindow - reserveTokens, Math.floor(params.minimumThresholdTokens ?? 0));
}

export function resolveResponsesServerCompactionThreshold(params: {
  contextWindowTokens: number;
  cfg?: OpenClawConfig;
  provider?: string;
  modelId?: string;
}): number | undefined {
  const provider = params.provider?.trim();
  const modelId = params.modelId?.trim();
  if (!provider || !modelId) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(provider);
  const normalizeModelId = (value: string) =>
    normalizeStaticProviderModelId(normalizedProvider, value).trim().toLowerCase();
  const providerConfig = resolveMergedModelProviderConfig(params.cfg, provider);
  const configuredModel = findConfiguredProviderModel(
    providerConfig,
    provider,
    modelId,
    normalizeModelId,
  );
  const { defaultParams, modelParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider,
    modelId,
  });
  const extraParams = { ...defaultParams, ...modelParams };
  const compactionModel = {
    provider,
    api: configuredModel?.api ?? providerConfig?.api,
    baseUrl: configuredModel?.baseUrl ?? providerConfig?.baseUrl,
    contextWindow: configuredModel?.contextWindow ?? params.contextWindowTokens,
  };
  if (normalizedProvider === "anthropic") {
    // The default Anthropic trigger sits below the local threshold, so only an explicit opt-in
    // (which may target any Claude model or a raised trigger) needs local compaction held back.
    if (extraParams.anthropicServerCompaction !== true) {
      return undefined;
    }
    return resolveAnthropicServerCompactionPlan(
      { ...compactionModel, api: compactionModel.api ?? "anthropic-messages" },
      extraParams,
    ).threshold;
  }
  return resolveOpenAIResponsesServerCompactionPlan(
    {
      ...compactionModel,
      api:
        compactionModel.api ?? (normalizedProvider === "openai" ? "openai-responses" : undefined),
      baseUrl:
        compactionModel.baseUrl ??
        (normalizedProvider === "openai" ? "https://api.openai.com/v1" : undefined),
      compat: configuredModel?.compat,
      contextTokens: configuredModel?.contextTokens ?? params.contextWindowTokens,
    },
    extraParams,
  ).threshold;
}


// FORK(memory-flush re-arm): upstream dropped resolvePositiveTokenCount.
function floorPositive(value: number | undefined): number | undefined {
  const positive = asPositiveFiniteNumber(value);
  return positive === undefined ? undefined : Math.floor(positive);
}
export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "totalTokensVersion" | "compactionCount" | "memoryFlush"
  >;
  /**
   * Optional token count override for flush gating. When provided, this value is
   * treated as a fresh context snapshot and used instead of the cached
   * SessionEntry.totalTokens (which may be stale/unknown).
   */
  tokenCount?: number;
  threshold: number;
  /**
   * FORK: Re-arm margin for the already-flushed gate. `compactionCount` only
   * advances on a compaction that actually landed, so a flush turn that
   * produced no compaction would otherwise suppress the signal forever while
   * context keeps climbing into the window. Callers pass the soft threshold.
   */
  rearmMarginTokens?: number;
}): boolean {
  if (!shouldRunPreflightCompaction(params) || !params.entry) {
    return false;
  }

  if (hasAlreadyFlushedForCurrentCompaction(params.entry)) {
    // FORK: re-arm once the session has grown a further margin past the point
    // where the last flush was signalled. `compactionCount` only advances on a
    // compaction that actually landed, so without a margin a flush turn that
    // produced no compaction suppresses the signal forever. Without a margin,
    // keep upstream's one-signal-per-cycle behavior.
    if (params.rearmMarginTokens === undefined) {
      return false;
    }
    const totalTokens =
      floorPositive(params.tokenCount) ?? resolveFreshSessionTotalTokens(params.entry);
    if (typeof totalTokens !== "number") {
      return false;
    }
    const rearmMargin = Math.max(1, Math.floor(params.rearmMarginTokens));
    const lastFlushTokens = floorPositive(params.entry.memoryFlush?.totalTokens);
    const rearmAt = (lastFlushTokens ?? params.threshold) + rearmMargin;
    if (totalTokens < rearmAt) {
      return false;
    }
  }

  return true;
}

export function shouldRunPreflightCompaction(params: {
  entry?: Pick<SessionEntry, "totalTokens" | "totalTokensFresh" | "totalTokensVersion">;
  /**
   * Optional projected token count override for pre-run compaction gating.
   * When provided, this value is treated as a fresh estimate and used instead
   * of any cached SessionEntry total.
   */
  tokenCount?: number;
  threshold: number;
}): boolean {
  if (!params.entry) {
    return false;
  }
  const projectedTokens = asPositiveFiniteNumber(params.tokenCount);
  const totalTokens =
    projectedTokens === undefined
      ? resolveFreshSessionTotalTokens(params.entry)
      : Math.floor(projectedTokens);
  return totalTokens !== undefined && params.threshold > 0 && totalTokens >= params.threshold;
}

/** One flush per compaction cycle, regardless of token or transcript-size trigger. */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlush">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0;
  return entry.memoryFlush?.compactionCount === compactionCount;
}

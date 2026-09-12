// Defines agent default configuration types shared by runtime schemas.
import type { z } from "zod";
import type {
  AgentModelConfig,
  AgentRuntimePolicyConfig,
  AgentSandboxConfig,
  AgentToolModelConfig,
} from "./types.agents-shared.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";
import type { AgentDefaultsBaseSchema } from "./zod-schema.agent-defaults-base.js";

type SchemaAgentDefaultsConfig = z.input<typeof AgentDefaultsBaseSchema>;

/** Workspace bootstrap-file injection policy for agent system prompts. */
export type AgentContextInjection = "always" | "continuation-skip" | "never";
/**
 * Optional bootstrap files that setup can skip while still creating required
 * agent files. "HEARTBEAT.md" stays accepted as legacy config input even
 * though workspace setup no longer writes it.
 */
export type OptionalBootstrapFileName = "SOUL.md" | "USER.md" | "HEARTBEAT.md" | "IDENTITY.md";
/** Embedded runner behavior contract used by strict-agentic provider flows. */
export type EmbeddedAgentExecutionContract = "default" | "strict-agentic";
/** Prompt-only default for how strongly agents should delegate to sub-agents. */
export type SubagentDelegationMode = "suggest" | "prefer";
/** Image compression/detail preference used before sending image inputs to models. */
export type AgentImageQualityPreference = "auto" | "efficient" | "balanced" | "high";
/** Scope of an interactive model selection when no explicit scope is supplied. */
export type ModelSelectionScope = "session" | "agent" | "global";
/** Canonical thinking levels accepted by agent defaults and compaction overrides. */
export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";

export type AgentModelEntryConfig = {
  /** Optional display/lookup alias for this provider/model entry. */
  alias?: string;
  /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>;
  /** Optional agent execution runtime for this specific provider/model entry. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** OpenClaw Code Mode override; omitted inherits the enclosing activation policy. */
  codeMode?: boolean;
  /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
  streaming?: boolean;
};

export type AgentModelPolicyConfig = {
  /** Model refs allowed for session/run overrides. Empty or omitted allows any model. */
  allow?: string[];
};

export type AgentModelListConfig = {
  /** Primary provider/model ref. */
  primary?: string;
  /** Ordered provider/model fallback refs. */
  fallbacks?: string[];
};

export type AgentContextPruningConfig = {
  /** Pruning mode for old tool results in model context. */
  mode?: "off" | "cache-ttl";
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  tools?: {
    /** Tool names eligible for context pruning. */
    allow?: string[];
    /** Tool names excluded from context pruning. */
    deny?: string[];
  };
  hardClear?: {
    /** Replace oversized old tool results with a placeholder at high pressure. */
    enabled?: boolean;
    /** Placeholder text inserted when a tool result is hard-cleared. */
    placeholder?: string;
  };
};

export type AgentStartupContextConfig = {
  /** Enable runtime-owned startup-context prelude on bare session resets (default: true). */
  enabled?: boolean;
  /** Which bare reset commands should receive startup context (default: ["new", "reset"]). */
  applyOn?: Array<"new" | "reset">;
  /** How many dated memory files to load counting backward from today (default: 2). */
  dailyMemoryDays?: number;
  /** Max bytes to read from each daily memory file before skipping (default: 16384). */
  maxFileBytes?: number;
  /** Max characters retained from each daily memory file (default: 1200). */
  maxFileChars?: number;
  /** Max total characters retained across the startup prelude (default: 2800). */
  maxTotalChars?: number;
};

export type AgentContextLimitsConfig = {
  /** Default max chars returned by memory_get before truncation metadata/notice (default: 12000). */
  memoryGetMaxChars?: number;
  /** Max chars retained from post-compaction AGENTS.md context injection (default: 1800). */
  postCompactionMaxChars?: number;
};

export type AgentDefaultsConfig = SchemaAgentDefaultsConfig & {
  /** @deprecated Doctor-only legacy input. */
  imageGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  videoGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  musicGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimezone?: string;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimestamp?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  envelopeElapsed?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  timeFormat?: "auto" | "12" | "24";
  /** @deprecated Doctor-only legacy input. */
  promptOverlays?: { gpt5?: { personality?: "friendly" | "on" | "off" } };
  /**
   * @deprecated Legacy raw config accepted only by doctor/migration repair.
   * Normal schema parsing rejects this key; use per-model agentRuntime instead.
   */
  agentRuntime?: AgentRuntimePolicyConfig;
  contextLimits?: AgentContextLimitsConfig;
  blockStreamingChunk?: BlockStreamingChunkConfig;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  humanDelay?: HumanDelayConfig;
  typingMode?: TypingMode;
  heartbeat?: {
    agentId?: string;
    every?: string;
    activeHours?: {
      start?: string;
      end?: string;
      timezone?: string;
    };
    model?: string;
    session?: string;
    target?: string;
    directPolicy?: "allow" | "block";
    to?: string;
    accountId?: string;
    prompt?: string;
    timeoutSeconds?: number;
    lightContext?: boolean;
    isolatedSession?: boolean;
  };
  /** Owner for ambient system-agent/Custodian inference and unscoped operator-read fallbacks. */
  systemAgent?: {
    agentId?: string;
    /**
     * FORK: upstream arms system-agent approval only on the Control UI chat
     * path, so an operator on a delegated surface (Discord/CLI) can never
     * approve a mutation and sees no card at all. When true, delegated chats
     * reuse the SAME host-side approval classifier the UI uses: consent is
     * read from the operator's own message text, never from a model assertion.
     * The model still cannot self-approve (the registered operation hash is
     * re-checked in system-agent-tool.ts) and unattended wizard/TUI setup
     * navigation stays refused.
     */
    trustDelegatedOperatorApproval?: boolean;
  };
  /** Upgrade-only owner for the inherited credential store until H2-2 relocates credentials. */
  authInheritance?: {
    agentId?: string;
  };
  /** Upgrade-only owner for retired main-agent rows and legacy fixed session stores. */
  sessionStore?: {
    agentId?: string;
  };
  /** Max concurrent agent runs across all conversations. Default: min(16, max(8, available CPU parallelism)). */
  maxConcurrent?: number;
  /** Sub-agent defaults (spawned via sessions_spawn). */
  subagents?: {
    /** Prompt-only guidance for how strongly the main agent should delegate work. Default: "suggest". */
    delegationMode?: SubagentDelegationMode;
    /** Default allowlist of target agent ids for sessions_spawn. Use "*" to allow any configured target. */
    allowAgents?: string[];
    /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 8. */
    maxConcurrent?: number;
    /** Maximum depth for sessions_spawn chains. Default behavior: 5. */
    maxSpawnDepth?: number;
    /** Maximum active children a single requester session may spawn. Default behavior: 5. */
    maxChildrenPerAgent?: number;
    /** Auto-archive sub-agent sessions after N minutes (default: 60, set 0 to disable). */
    archiveAfterMinutes?: number;
    /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
    /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
    thinking?: string;
    /** Default run timeout in seconds for spawned sub-agents (0 = no timeout). */
    runTimeoutSeconds?: number;
    /** Gateway timeout in ms for sub-agent announce delivery calls (default: 120000). */
    announceTimeoutMs?: number;
    /** Require explicit agentId in sessions_spawn (no default same-as-caller). Default: false. */
    requireAgentId?: boolean;
  };
  /** Optional sandbox settings for non-main sessions. */
  sandbox?: AgentSandboxConfig;
};

export type AgentCompactionMode = "default" | "safeguard" | "agent";
export type AgentCompactionPostIndexSyncMode = "off" | "async" | "await";
export type AgentCompactionIdentifierPolicy = "strict" | "off";
export type AgentCompactionQualityGuardConfig = {
  /** Enable compaction summary quality audits and regeneration retries. Default: false. */
  enabled?: boolean;
  /** Maximum regeneration retries after a failed quality audit. Default: 1 when enabled. */
  maxRetries?: number;
};

export type AgentCompactionMidTurnPrecheckConfig = {
  /**
   * Enable structured context pressure checks after tool results are appended
   * and before the next agent model call. Default: false.
   */
  enabled?: boolean;
};

export type AgentCompactionConfig = {
  /** Enable embedded proactive auto-compaction. Default: true. */
  enabled?: boolean;
  /** Compaction summarization mode. */
  mode?: AgentCompactionMode;
  /** Thinking level for embedded OpenClaw compaction summaries. Default: low. */
  thinkingLevel?: AgentThinkingLevel | "inherit";
  /** Embedded OpenClaw keepRecentTokens budget used for cut-point selection. */
  keepRecentTokens?: number;
  /** Preserve this many most-recent user/assistant turns verbatim in compaction summary context. */
  recentTurnsPreserve?: number;
  /** Identifier-preservation instruction policy for compaction summaries. */
  identifierPolicy?: AgentCompactionIdentifierPolicy;
  /** Optional quality-audit retries for safeguard compaction summaries. */
  qualityGuard?: AgentCompactionQualityGuardConfig;
  /** Mid-turn precheck for tool-loop context pressure. Default: disabled. */
  midTurnPrecheck?: AgentCompactionMidTurnPrecheckConfig;
  /** Post-compaction session memory index sync mode. */
  postIndexSync?: AgentCompactionPostIndexSyncMode;
  /** Pre-compaction memory flush (agentic turn). Default: enabled. */
  memoryFlush?: AgentCompactionMemoryFlushConfig;
  /** H2/H3 section names from AGENTS.md to inject after compaction. */
  postCompactionSections?: string[];
  /** Optional provider/model or configured bare alias for compaction summarization.
   * When set, compaction uses this model instead of the agent's primary model.
   * Falls back to the primary model when unset. */
  model?: string;
  /** Safety window in seconds for each built-in compaction model request (default: 180). */
  timeoutSeconds?: number;
  /**
   * Id of a registered compaction provider plugin.
   * When set, the provider's summarize() is called instead of
   * the built-in summarizeInStages(). Falls back to built-in on failure.
   */
  provider?: string;
  /**
   * Byte threshold for normal preflight local compaction (bytes, or a byte-size
   * string like "20mb"). Set to 0 or leave unset to disable. Also caps Codex
   * app-server native rollouts; oversized native threads restart fresh.
   */
  maxActiveTranscriptBytes?: number | string;
  /**
   * Send brief context-maintenance notices to the user: when compaction starts
   * and completes, and when a pre-compaction memory flush is exhausted so the
   * reply continues in a degraded state.
   * Default: false (silent by default).
   */
  notifyUser?: boolean;
};

export type AgentCompactionMemoryFlushConfig = {
  /** Enable the pre-compaction memory flush (default: true). */
  enabled?: boolean;
  /** Optional provider/model override used only for pre-compaction memory flush turns. */
  model?: string;
  /** Run the memory flush when context is within this many tokens of the compaction threshold. */
  softThresholdTokens?: number;
  /**
   * Force a memory flush when transcript size reaches this threshold
   * (bytes, or byte-size string like "2mb"). Set to 0 to disable.
   */
  forceFlushTranscriptBytes?: number | string;
};

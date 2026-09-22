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
import type { AgentContextLimitsSchema, HeartbeatSchema } from "./zod-schema.agent-runtime.js";

type SchemaAgentDefaultsConfig = z.input<typeof AgentDefaultsBaseSchema>;

export type AgentContextInjection = NonNullable<SchemaAgentDefaultsConfig["contextInjection"]>;
export type OptionalBootstrapFileName = NonNullable<
  SchemaAgentDefaultsConfig["skipOptionalBootstrapFiles"]
>[number];
export type EmbeddedAgentExecutionContract = NonNullable<
  NonNullable<SchemaAgentDefaultsConfig["embeddedAgent"]>["executionContract"]
>;
export type SubagentDelegationMode = NonNullable<
  NonNullable<SchemaAgentDefaultsConfig["subagents"]>["delegationMode"]
>;
export type AgentImageQualityPreference = NonNullable<SchemaAgentDefaultsConfig["imageQuality"]>;
export type ModelSelectionScope = NonNullable<SchemaAgentDefaultsConfig["modelSelectionScope"]>;
export type AgentThinkingLevel = NonNullable<SchemaAgentDefaultsConfig["thinkingDefault"]>;

export type AgentModelEntryConfig = NonNullable<SchemaAgentDefaultsConfig["models"]>[string];

export type AgentModelPolicyConfig = NonNullable<SchemaAgentDefaultsConfig["modelPolicy"]>;

export type AgentModelListConfig = Exclude<NonNullable<SchemaAgentDefaultsConfig["model"]>, string>;

export type AgentContextPruningConfig = NonNullable<SchemaAgentDefaultsConfig["contextPruning"]>;

export type AgentStartupContextConfig = NonNullable<SchemaAgentDefaultsConfig["startupContext"]>;

export type AgentContextLimitsConfig = NonNullable<z.input<typeof AgentContextLimitsSchema>>;

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
  heartbeat?: NonNullable<z.input<typeof HeartbeatSchema>> & {
    agentId?: string;
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
export type AgentCompactionMode = NonNullable<AgentCompactionConfig["mode"]>;
export type AgentCompactionPostIndexSyncMode = NonNullable<AgentCompactionConfig["postIndexSync"]>;
export type AgentCompactionIdentifierPolicy = NonNullable<
  AgentCompactionConfig["identifierPolicy"]
>;
export type AgentCompactionQualityGuardConfig = NonNullable<AgentCompactionConfig["qualityGuard"]>;

export type AgentCompactionMidTurnPrecheckConfig = NonNullable<
  AgentCompactionConfig["midTurnPrecheck"]
>;

export type AgentCompactionConfig = NonNullable<SchemaAgentDefaultsConfig["compaction"]>;

export type AgentCompactionMemoryFlushConfig = NonNullable<AgentCompactionConfig["memoryFlush"]>;

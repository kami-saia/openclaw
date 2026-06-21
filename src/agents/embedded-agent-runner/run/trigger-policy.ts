/**
 * Resolves trigger-specific prompt injection behavior.
 */
import type { EmbeddedRunTrigger } from "./params.js";

type EmbeddedRunTriggerPolicy = {
  injectHeartbeatPrompt: boolean;
};

const DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY: EmbeddedRunTriggerPolicy = {
  // FORK: default-agent non-cron/non-heartbeat runs SHOULD inject the heartbeat
  // prompt (e.g. user-driven turns on the heartbeat agent). Upstream defaults
  // this to false and only injects for the heartbeat trigger; the fork inverts
  // it so interactive turns keep heartbeat context while scheduler/exec wakes
  // below explicitly suppress it.
  injectHeartbeatPrompt: true,
};

const EMBEDDED_RUN_TRIGGER_POLICY: Partial<Record<EmbeddedRunTrigger, EmbeddedRunTriggerPolicy>> = {
  // FORK: cron-triggered runs suppress the heartbeat prompt so cron wakes don't
  // re-execute the heartbeat checklist on every event.
  cron: {
    injectHeartbeatPrompt: false,
  },
  // FORK: exec completion / scheduler heartbeat wakes should not inject the
  // heartbeat prompt. Without this, exec:*:exit events on non-main sessions
  // cause the agent to read HEARTBEAT.md and run the full heartbeat checklist.
  heartbeat: {
    injectHeartbeatPrompt: false,
  },
};

/**
 * Decides whether a run trigger should add the heartbeat-specific prompt
 * instruction. Unknown or omitted triggers fall back to the user-prompt shape
 * so non-heartbeat runs do not get scheduler wording.
 */
export function shouldInjectHeartbeatPromptForTrigger(trigger?: EmbeddedRunTrigger): boolean {
  return (
    (trigger ? EMBEDDED_RUN_TRIGGER_POLICY[trigger] : undefined)?.injectHeartbeatPrompt ??
    DEFAULT_EMBEDDED_RUN_TRIGGER_POLICY.injectHeartbeatPrompt
  );
}

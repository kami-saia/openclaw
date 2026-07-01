// FORK: Trigger policy tests pin the fork's inverted heartbeat-prompt behavior.
// Upstream defaults injectHeartbeatPrompt to false and only injects for the
// heartbeat trigger. The fork inverts this so interactive/default turns keep
// heartbeat context, while scheduler-originated wakes (cron, heartbeat) suppress
// it so they don't re-run the HEARTBEAT.md checklist on every event.
// See trigger-policy.ts FORK comments.
import { describe, expect, it } from "vitest";
import { shouldInjectHeartbeatPromptForTrigger } from "./trigger-policy.js";

describe("shouldInjectHeartbeatPromptForTrigger", () => {
  it.each([["cron"] as const, ["heartbeat"] as const])(
    "FORK: suppresses the heartbeat prompt on scheduler-originated %s wakes",
    (trigger) => {
      expect(shouldInjectHeartbeatPromptForTrigger(trigger)).toBe(false);
    },
  );

  it.each([["user"] as const, ["manual"] as const, ["memory"] as const, ["overflow"] as const])(
    "FORK: injects the heartbeat prompt on %s-triggered runs (interactive turns keep heartbeat context)",
    (trigger) => {
      expect(shouldInjectHeartbeatPromptForTrigger(trigger)).toBe(true);
    },
  );

  it("FORK: injects the heartbeat prompt when no trigger is supplied (default-agent shape)", () => {
    expect(shouldInjectHeartbeatPromptForTrigger(undefined)).toBe(true);
  });
});

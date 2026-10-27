import { describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  createRestartRecoveryRequesterSource,
  readRestartRecoveryChannelOperatorSource,
  readRestartRecoveryRequesterSource,
} from "./requester-run-recovery-source.js";

const { basis } = vi.hoisted(() => ({
  basis: { kind: "channel", snapshot: { profileId: "p1" } },
}));
vi.mock("../gateway/operator-run-recovery-source.js", () => ({
  captureQueuedOperatorRecoverySource: () => basis,
}));

// FORK: channel turns retain their linked operator basis on the requester claim.
describe("restart recovery requester channel operator basis", () => {
  const entry = { sessionId: "s1", lifecycleRevision: "r1" } as InternalSessionEntry;
  const claim = {
    agentId: "main",
    sessionKey: "agent:main:discord:channel:1",
    sourceRunId: "turn",
  };
  const authority = { profileId: "p1" } as AdmittedRunOperatorAuthority;

  it("binds the basis to the exact current claim of a linked requester", () => {
    const source = createRestartRecoveryRequesterSource({
      ...claim,
      entry,
      requesterOrigin: { sessionKey: claim.sessionKey, operatorProfileId: "p1" },
      channelOperatorAuthority: authority,
    });
    const bound = { ...entry, restartRecoveryRequesterSource: source };
    expect(readRestartRecoveryRequesterSource({ ...claim, entry: bound })).toMatchObject({
      operatorProfileId: "p1",
    });
    expect(readRestartRecoveryChannelOperatorSource({ ...claim, entry: bound })).toEqual({
      profileId: "p1",
      source: basis,
    });
    expect(
      readRestartRecoveryChannelOperatorSource({ ...claim, sourceRunId: "other", entry: bound }),
    ).toBeUndefined();
    expect(
      readRestartRecoveryChannelOperatorSource({
        ...claim,
        entry: { ...bound, lifecycleRevision: "r2" },
      }),
    ).toBeUndefined();
  });

  it("never retains a basis for an unlinked requester", () => {
    const source = createRestartRecoveryRequesterSource({
      ...claim,
      entry,
      requesterOrigin: {
        sessionKey: claim.sessionKey,
        messageProvider: "discord",
        senderId: "u1",
      },
      channelOperatorAuthority: authority,
    });
    expect(source).toBeDefined();
    expect(source).not.toHaveProperty("channelOperator");
    expect(
      readRestartRecoveryChannelOperatorSource({
        ...claim,
        entry: { ...entry, restartRecoveryRequesterSource: source },
      }),
    ).toBeUndefined();
  });
});

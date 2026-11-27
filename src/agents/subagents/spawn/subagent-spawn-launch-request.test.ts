import { describe, expect, it } from "vitest";
import { buildSubagentLaunchRequest } from "./subagent-spawn-launch-request.js";

describe("buildSubagentLaunchRequest", () => {
  it("marks the spawn task as the parent's inter-session assignment", () => {
    const { childLaunch } = buildSubagentLaunchRequest({
      completionMode: "announce",
      spawnMode: "run",
      message: "Summarize the logs.",
      spawnedByKey: "agent:main:discord:channel:123",
      toolSpawnMetadata: {},
      childSessionKey: "agent:main:subagent:abc",
      childSession: {},
      childIdem: "run-1",
      childSystemPrompt: "",
      runTimeoutSeconds: 0,
      lightContext: false,
      swarmMaxConcurrent: 1,
    });
    expect(childLaunch.request.inputProvenance).toEqual({
      kind: "inter_session",
      sourceSessionKey: "agent:main:discord:channel:123",
      sourceChannel: "internal",
      sourceTool: "sessions_spawn",
      sourceRelation: "parent",
    });
  });

  it("leaves a blind child's task unattributed so its prompt never names the requester", () => {
    const { childLaunch } = buildSubagentLaunchRequest({
      completionMode: "collector",
      spawnMode: "run",
      message: "Summarize the logs.",
      spawnedByKey: "agent:main:discord:channel:123",
      blind: true,
      toolSpawnMetadata: {},
      childSessionKey: "agent:main:subagent:abc",
      childSession: {},
      childIdem: "run-1",
      childSystemPrompt: "",
      runTimeoutSeconds: 0,
      lightContext: false,
      swarmMaxConcurrent: 1,
    });
    expect(childLaunch.request).not.toHaveProperty("inputProvenance");
  });
});

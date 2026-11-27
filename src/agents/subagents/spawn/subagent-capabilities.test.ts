/**
 * Regression coverage for depth-derived subagent capabilities.
 * Verifies main/orchestrator/leaf role and control-scope decisions.
 */
import { describe, expect, it } from "vitest";
import {
  resolveSubagentCapabilities,
  visibleParentInputProvenance,
} from "./subagent-capabilities.js";

describe("resolveSubagentCapabilities", () => {
  it("returns normalized depth for non-finite direct inputs", () => {
    expect(
      resolveSubagentCapabilities({
        depth: Number.NaN,
        maxSpawnDepth: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      depth: 0,
      role: "main",
      controlScope: "children",
    });
  });

  it("floors finite depth and max depth consistently", () => {
    expect(resolveSubagentCapabilities({ depth: 1.9, maxSpawnDepth: 1.2 })).toEqual({
      depth: 1,
      role: "leaf",
      controlScope: "none",
    });
  });

  it("makes children at the default recursion boundary leaves", () => {
    expect(resolveSubagentCapabilities({ depth: 1_000 })).toEqual({
      depth: 1_000,
      role: "leaf",
      controlScope: "none",
    });
  });
});

describe("visibleParentInputProvenance", () => {
  const parent = "agent:main:discord:channel:123";
  const child = "agent:main:subagent:abc";

  it("verifies the stored spawning parent of a hidden subagent", () => {
    expect(visibleParentInputProvenance(parent, child, { spawnedBy: parent })).toEqual({
      sourceRelation: "parent",
    });
  });

  it("refuses a parent claim the child's stored lineage does not confirm", () => {
    expect(visibleParentInputProvenance("agent:main:other", child, { spawnedBy: parent })).toEqual(
      {},
    );
    expect(visibleParentInputProvenance(parent, child, undefined)).toEqual({});
    expect(visibleParentInputProvenance(undefined, child, { spawnedBy: parent })).toEqual({});
  });
});

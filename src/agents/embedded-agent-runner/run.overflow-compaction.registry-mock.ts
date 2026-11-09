/**
 * Context-engine registry mock for the embedded-run overflow compaction harness.
 */

import { vi } from "vitest";
import type { ContextEngine } from "../../context-engine/types.js";

export function createOverflowCompactionRegistryMock(params: {
  resolveContextEngine: () => Promise<unknown>;
  resolveContextEngineOwnerPluginId: () => string | undefined;
}) {
  return {
    hasSameContextEngineInstance: vi.fn(
      (left: ContextEngine, right: ContextEngine) => left === right,
    ),
    resolveContextEngine: params.resolveContextEngine,
    resolveContextEngineOwnerPluginId: params.resolveContextEngineOwnerPluginId,
    resolveLogicalTurnContextEngines: async () => {
      const engine = await params.resolveContextEngine();
      const ref = { engine, registeredId: "legacy" };
      return { configured: ref, configuredId: "legacy", fallback: ref };
    },
  };
}

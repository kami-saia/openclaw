/**
 * Message-provider tool filtering.
 * Channels can restrict tool names after runtime assembly when the active
 * transport cannot safely render or execute a class of tools.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

const TOOL_DENY_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  "discord-voice": ["tts"],
  voice: ["tts"],
};

const TOOL_ALLOW_BY_MESSAGE_PROVIDER: Readonly<Record<string, readonly string[]>> = {
  node: ["canvas", "image", "pdf", "tts", "web_fetch", "web_search"],
};

// Scoped, per-device carve-out for the generic `node` transport allowlist above.
// Only these two specific paired devices (Damon's Eyrie phone and Pawr/VS Code)
// get full tool access when connecting as a node; any other/unrecognized node
// device id still falls through to the restrictive TOOL_ALLOW_BY_MESSAGE_PROVIDER.node
// list. Do NOT widen the generic `node` entry itself — see Aug 7 incident
// (commit bdcc691745a) where a merge accidentally deleted the node allowlist
// entirely, granting all paired nodes full exec/write access.
const FULL_ACCESS_NODE_DEVICE_IDS: ReadonlySet<string> = new Set([
  // Eyrie (Android)
  "d8c07a9d76d9e561a874d30e015322e57d6f1cad644b7cb82f3b6213c0f034d2",
  // Pawr (VS Code)
  "ed0f6bb4782ef8f52803c3168b41f9d1e5c726644affe8a2b120022d64fca66d",
]);

/** Applies message-provider filtering while preserving duplicate tool entries. */
export function filterToolsByMessageProvider<TTool extends { name: string }>(
  tools: readonly TTool[],
  messageProvider?: string,
  nodeDeviceId?: string,
): TTool[] {
  const normalizedProvider = normalizeOptionalLowercaseString(messageProvider);
  if (!normalizedProvider) {
    return [...tools];
  }
  if (
    normalizedProvider === "node" &&
    nodeDeviceId &&
    FULL_ACCESS_NODE_DEVICE_IDS.has(nodeDeviceId)
  ) {
    return [...tools];
  }
  const allowedTools = TOOL_ALLOW_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (allowedTools && allowedTools.length > 0) {
    const allowedSet = new Set(allowedTools);
    return tools.filter((tool) => allowedSet.has(tool.name));
  }
  const deniedTools = TOOL_DENY_BY_MESSAGE_PROVIDER[normalizedProvider];
  if (!deniedTools || deniedTools.length === 0) {
    return [...tools];
  }
  const deniedSet = new Set(deniedTools);
  return tools.filter((tool) => !deniedSet.has(tool.name));
}

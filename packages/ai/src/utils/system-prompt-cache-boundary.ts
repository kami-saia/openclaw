/**
 * System prompt cache-boundary helpers.
 *
 * Keeps stable prompt prefixes separate from dynamic runtime additions for provider prompt caching.
 */
import { normalizeStructuredPromptSection } from "./prompt-cache-stability.js";

export const SYSTEM_PROMPT_CACHE_BOUNDARY = "\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n";

// FORK: identity boundary. Marks the end of the constitutive identity section
// (SOUL.md) and the start of operational guidance. Transports that expose a
// role hierarchy emit the identity half at the higher-authority role and the
// operational half below it, instead of flattening both into one blob at equal
// standing. Transports without a hierarchy strip the marker and are unchanged.
export const SYSTEM_PROMPT_IDENTITY_BOUNDARY = "\n<!-- OPENCLAW_IDENTITY_BOUNDARY -->\n";

export function splitSystemPromptIdentityBoundary(
  text: string,
): { identity: string; operational: string } | undefined {
  const index = text.indexOf(SYSTEM_PROMPT_IDENTITY_BOUNDARY);
  if (index === -1) {
    return undefined;
  }
  const identity = text.slice(0, index).trimEnd();
  const operational = text.slice(index + SYSTEM_PROMPT_IDENTITY_BOUNDARY.length).trimStart();
  if (!identity || !operational) {
    return undefined;
  }
  return { identity, operational };
}

export function stripSystemPromptCacheBoundary(text: string): string {
  // Also strips the identity boundary: both are internal structure markers that
  // must never reach a provider payload, and every transport already funnels
  // system-prompt text through this one call.
  return text
    .replaceAll(SYSTEM_PROMPT_CACHE_BOUNDARY, "\n")
    .replaceAll(SYSTEM_PROMPT_IDENTITY_BOUNDARY, "\n");
}

// Append the cache boundary when a prompt has none (e.g. a hook systemPrompt override),
// so dynamic additions route into an uncached suffix instead of the cached prefix (#85203).
export function ensureSystemPromptCacheBoundary(systemPrompt: string): string {
  if (systemPrompt.trim().length === 0) {
    return systemPrompt;
  }
  return systemPrompt.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)
    ? systemPrompt
    : `${systemPrompt}${SYSTEM_PROMPT_CACHE_BOUNDARY}`;
}

export function splitSystemPromptCacheBoundary(
  text: string,
): { stablePrefix: string; dynamicSuffix: string } | undefined {
  const boundaryIndex = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  if (boundaryIndex === -1) {
    return undefined;
  }
  return {
    stablePrefix: text.slice(0, boundaryIndex).trimEnd(),
    dynamicSuffix: text.slice(boundaryIndex + SYSTEM_PROMPT_CACHE_BOUNDARY.length).trimStart(),
  };
}

export function prependSystemPromptAdditionAfterCacheBoundary(params: {
  systemPrompt: string;
  systemPromptAddition?: string;
}): string {
  const systemPromptAddition =
    typeof params.systemPromptAddition === "string"
      ? normalizeStructuredPromptSection(params.systemPromptAddition)
      : "";
  if (!systemPromptAddition) {
    return params.systemPrompt;
  }
  if (params.systemPrompt.trim().length === 0) {
    return systemPromptAddition;
  }

  const split = splitSystemPromptCacheBoundary(params.systemPrompt);
  if (!split) {
    return `${systemPromptAddition}\n\n${params.systemPrompt}`;
  }

  const dynamicSuffix = split.dynamicSuffix
    ? normalizeStructuredPromptSection(split.dynamicSuffix)
    : "";
  if (!dynamicSuffix) {
    return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}`;
  }

  return `${split.stablePrefix}${SYSTEM_PROMPT_CACHE_BOUNDARY}${systemPromptAddition}\n\n${dynamicSuffix}`;
}

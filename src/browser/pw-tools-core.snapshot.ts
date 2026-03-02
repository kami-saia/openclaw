import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { type AriaSnapshotNode } from "./cdp.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import {
  buildRoleSnapshotFromAiSnapshot,
  buildRoleSnapshotFromAriaSnapshot,
  getRoleSnapshotStats,
  type RoleSnapshotOptions,
  type RoleRefMap,
} from "./pw-role-snapshot.js";
import {
  ensurePageState,
  forceDisconnectPlaywrightForTarget,
  getPageForTargetId,
  storeRoleRefsForTarget,
  type WithSnapshotForAI,
} from "./pw-session.js";

export async function snapshotAriaViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  limit?: number;
}): Promise<{ nodes: AriaSnapshotNode[] }> {
  const limit = Math.max(1, Math.min(2000, Math.floor(opts.limit ?? 500)));
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  // Use Playwright locator.ariaSnapshot() instead of CDP Accessibility.getFullAXTree.
  // CDP misses React portals and content rendered outside the main a11y tree;
  // Playwright queries the live DOM through its locator engine.
  const ariaSnapshot = await page.locator(":root").ariaSnapshot();
  const text = String(ariaSnapshot ?? "");
  const rawLines = text.split("\n").filter((l: string) => l.trim().length > 0);
  const nodes: AriaSnapshotNode[] = [];
  for (let i = 0; i < rawLines.length && nodes.length < limit; i++) {
    const line = rawLines[i];
    const stripped = line.replace(/^[\s-]+/, "");
    const indent = line.search(/\S/);
    const depth = Math.max(0, Math.floor(indent / 2));
    const roleMatch = stripped.match(/^(\w+)(?:\s+"(.*)")?/);
    nodes.push({
      ref: String(i + 1),
      role: roleMatch?.[1] ?? "text",
      name: roleMatch?.[2] ?? stripped,
      depth,
    });
  }
  return { nodes };
}

export async function snapshotAiViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<{ snapshot: string; truncated?: boolean; refs: RoleRefMap }> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  const maybe = page as unknown as WithSnapshotForAI;
  if (!maybe._snapshotForAI) {
    throw new Error("Playwright _snapshotForAI is not available. Upgrade playwright-core.");
  }

  const result = await maybe._snapshotForAI({
    timeout: Math.max(500, Math.min(60_000, Math.floor(opts.timeoutMs ?? 5000))),
    track: "response",
  });
  let snapshot = String(result?.full ?? "");
  const maxChars = opts.maxChars;
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : undefined;
  let truncated = false;
  if (limit && snapshot.length > limit) {
    snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
    truncated = true;
  }

  const built = buildRoleSnapshotFromAiSnapshot(snapshot);
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: built.refs,
    mode: "aria",
  });
  return truncated ? { snapshot, truncated, refs: built.refs } : { snapshot, refs: built.refs };
}

export async function snapshotRoleViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  selector?: string;
  frameSelector?: string;
  refsMode?: "role" | "aria";
  options?: RoleSnapshotOptions;
}): Promise<{
  snapshot: string;
  refs: Record<string, { role: string; name?: string; nth?: number }>;
  stats: { lines: number; chars: number; refs: number; interactive: number };
}> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  if (opts.refsMode === "aria") {
    if (opts.selector?.trim() || opts.frameSelector?.trim()) {
      throw new Error("refs=aria does not support selector/frame snapshots yet.");
    }
    const maybe = page as unknown as WithSnapshotForAI;
    if (!maybe._snapshotForAI) {
      throw new Error("refs=aria requires Playwright _snapshotForAI support.");
    }
    const result = await maybe._snapshotForAI({
      timeout: 5000,
      track: "response",
    });
    const built = buildRoleSnapshotFromAiSnapshot(String(result?.full ?? ""), opts.options);
    storeRoleRefsForTarget({
      page,
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      refs: built.refs,
      mode: "aria",
    });
    return {
      snapshot: built.snapshot,
      refs: built.refs,
      stats: getRoleSnapshotStats(built.snapshot, built.refs),
    };
  }

  const frameSelector = opts.frameSelector?.trim() || "";
  const selector = opts.selector?.trim() || "";
  const locator = frameSelector
    ? selector
      ? page.frameLocator(frameSelector).locator(selector)
      : page.frameLocator(frameSelector).locator(":root")
    : selector
      ? page.locator(selector)
      : page.locator(":root");

  const ariaSnapshot = await locator.ariaSnapshot();
  const built = buildRoleSnapshotFromAriaSnapshot(String(ariaSnapshot ?? ""), opts.options);
  storeRoleRefsForTarget({
    page,
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: built.refs,
    frameSelector: frameSelector || undefined,
    mode: "role",
  });
  return {
    snapshot: built.snapshot,
    refs: built.refs,
    stats: getRoleSnapshotStats(built.snapshot, built.refs),
  };
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ url: string }> {
  const isRetryableNavigateError = (err: unknown): boolean => {
    const msg =
      typeof err === "string"
        ? err.toLowerCase()
        : err instanceof Error
          ? err.message.toLowerCase()
          : "";
    return (
      msg.includes("frame has been detached") ||
      msg.includes("target page, context or browser has been closed")
    );
  };

  const url = String(opts.url ?? "").trim();
  if (!url) {
    throw new Error("url is required");
  }
  await assertBrowserNavigationAllowed({
    url,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });
  const timeout = Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 20_000));
  let page = await getPageForTargetId(opts);
  ensurePageState(page);
  try {
    await page.goto(url, { timeout });
  } catch (err) {
    if (!isRetryableNavigateError(err)) {
      throw err;
    }
    // Extension relays can briefly drop CDP during renderer swaps/navigation.
    // Force a clean reconnect, then retry once on the refreshed page handle.
    await forceDisconnectPlaywrightForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      reason: "retry navigate after detached frame",
    }).catch(() => {});
    page = await getPageForTargetId(opts);
    ensurePageState(page);
    await page.goto(url, { timeout });
  }
  const finalUrl = page.url();
  await assertBrowserNavigationResultAllowed({
    url: finalUrl,
    ...withBrowserNavigationPolicy(opts.ssrfPolicy),
  });
  return { url: finalUrl };
}

export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.setViewportSize({
    width: Math.max(1, Math.floor(opts.width)),
    height: Math.max(1, Math.floor(opts.height)),
  });
}

export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { isSessionWriteLockTimeoutError } from "../../session-write-lock-error.js";
import type { acquireSessionWriteLock } from "../../session-write-lock.js";

// Maximum number of bytes of the original file tail we hash for the append-only
// fence verification. 4 KiB is large enough to catch any in-place edit that
// rewrites the trailing line of a JSONL transcript (assistant messages, even
// large delivery-mirror entries, easily fit), and small enough that the read
// is negligible compared with the surrounding I/O work.
const SESSION_FENCE_TAIL_BYTES = 4096;

type SessionLock = Awaited<ReturnType<typeof acquireSessionWriteLock>>;
type AcquireSessionWriteLock = typeof acquireSessionWriteLock;

type LockOptions = {
  sessionFile: string;
  timeoutMs: number;
  staleMs: number;
  maxHoldMs: number;
};

type SessionEventProcessor = {
  _processAgentEvent?: (event: unknown) => Promise<void>;
  _extensionRunner?: {
    hasHandlers?: (eventType: string) => boolean;
  };
  __openclawSessionEventWriteLockInstalled?: boolean;
};

type SessionEventQueueOwner = {
  _agentEventQueue?: PromiseLike<unknown>;
};

type SessionWithAgentPrompt = {
  agent?: {
    streamFn?: PromptReleaseStreamFn;
  };
};

type SessionWithExternalHooks = SessionEventProcessor & {
  compact?: LockableFunction;
  agent?: {
    beforeToolCall?: LockableFunction;
    afterToolCall?: LockableFunction;
    onPayload?: LockableFunction;
    onResponse?: LockableFunction;
  };
};

type PromptReleaseStreamFn = ((...args: unknown[]) => unknown) & {
  __openclawSessionLockPromptReleaseInstalled?: boolean;
};

type LockableFunction = ((...args: unknown[]) => unknown) & {
  __openclawSessionWriteLockInstalled?: boolean;
};

function sessionHasExtensionHandlers(session: SessionEventProcessor, eventType: string): boolean {
  const hasHandlers = session._extensionRunner?.hasHandlers;
  if (typeof hasHandlers !== "function") {
    return false;
  }
  try {
    return hasHandlers.call(session._extensionRunner, eventType);
  } catch {
    return true;
  }
}

function eventMayReachTranscriptWriters(session: SessionEventProcessor, event: unknown): boolean {
  const type = (event as { type?: unknown } | null)?.type;
  if (type === "message_update" || type === "message_end" || type === "agent_end") {
    return true;
  }
  if (typeof type !== "string") {
    return false;
  }
  return sessionHasExtensionHandlers(session, type);
}

function installLockableFunction(params: {
  owner: Record<string, unknown>;
  key: string;
  shouldLock: () => boolean;
  waitBeforeLock?: () => Promise<void>;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const current = params.owner[params.key] as LockableFunction | undefined;
  if (typeof current !== "function" || current.__openclawSessionWriteLockInstalled === true) {
    return;
  }
  const wrapped: LockableFunction = async function lockedExternalHook(
    this: unknown,
    ...args: unknown[]
  ) {
    if (!params.shouldLock()) {
      return await current.apply(this, args);
    }
    await params.waitBeforeLock?.();
    return await params.withSessionWriteLock(async () => await current.apply(this, args));
  };
  wrapped.__openclawSessionWriteLockInstalled = true;
  params.owner[params.key] = wrapped;
}

type SessionFileFingerprint =
  | { exists: false }
  | {
      exists: true;
      dev: bigint;
      ino: bigint;
      size: bigint;
      mtimeNs: bigint;
      ctimeNs: bigint;
      /** SHA-256 of the trailing SESSION_FENCE_TAIL_BYTES of the file at fence time. */
      tailDigest: string;
      /** Number of bytes the tailDigest actually covers (<= size). */
      tailLength: bigint;
    };

function sameSessionFileFingerprint(
  left: SessionFileFingerprint | undefined,
  right: SessionFileFingerprint,
): boolean {
  if (!left || left.exists !== right.exists) {
    return false;
  }
  if (!left.exists || !right.exists) {
    return true;
  }
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.tailDigest === right.tailDigest &&
    left.tailLength === right.tailLength
  );
}

/**
 * Returns true when `current` looks like a pure append of new bytes to the
 * file described by `prior`: same dev/ino, size grew (or stayed equal), and
 * the bytes that used to live at the tail of the file are still byte-for-byte
 * intact at the same offsets.
 *
 * The gateway's own outbound delivery path (`appendAssistantMessageToSession
 * Transcript` -> `appendSessionTranscriptMessage`) acquires the session write
 * lock during the released window, appends a `delivery-mirror` assistant
 * message, then releases the lock. That changes size/mtime/ctime but never
 * touches existing bytes, so it must NOT be treated as a takeover.
 */
function isPureAppendExtension(
  prior: SessionFileFingerprint | undefined,
  current: SessionFileFingerprint,
  currentTailOfPriorRegion: { digest: string; length: bigint } | undefined,
): boolean {
  if (!prior || !prior.exists || !current.exists) {
    return false;
  }
  if (prior.dev !== current.dev || prior.ino !== current.ino) {
    return false;
  }
  if (current.size < prior.size) {
    return false;
  }
  if (!currentTailOfPriorRegion) {
    return false;
  }
  // If the prior file had zero bytes there is nothing to verify -- any
  // post-release state, including a freshly-recreated file at the same inode
  // number (inode reuse after rm+create is common on Linux), would trivially
  // satisfy a zero-length tail check. Force the strict fingerprint path in
  // that case.
  if (prior.tailLength === 0n) {
    return false;
  }
  return (
    currentTailOfPriorRegion.length === prior.tailLength &&
    currentTailOfPriorRegion.digest === prior.tailDigest
  );
}

async function readSessionFileTailDigest(
  sessionFile: string,
  size: bigint,
): Promise<{ digest: string; length: bigint }> {
  const tailLength =
    size < BigInt(SESSION_FENCE_TAIL_BYTES) ? size : BigInt(SESSION_FENCE_TAIL_BYTES);
  if (tailLength === 0n) {
    return { digest: createHash("sha256").digest("hex"), length: 0n };
  }
  const handle = await fs.open(sessionFile, "r");
  try {
    const buffer = Buffer.allocUnsafe(Number(tailLength));
    const position = size - tailLength;
    await handle.read(buffer, 0, buffer.length, Number(position));
    return {
      digest: createHash("sha256").update(buffer).digest("hex"),
      length: tailLength,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Hash the bytes of `sessionFile` from offset `(priorSize - priorTailLength)`
 * for `priorTailLength` bytes. Used to verify that the bytes that previously
 * formed the tail of the file are still intact after a size change.
 */
async function readSessionFileRegionDigest(
  sessionFile: string,
  priorSize: bigint,
  priorTailLength: bigint,
): Promise<{ digest: string; length: bigint } | undefined> {
  if (priorTailLength === 0n) {
    return { digest: createHash("sha256").digest("hex"), length: 0n };
  }
  if (priorSize < priorTailLength) {
    return undefined;
  }
  const position = priorSize - priorTailLength;
  let handle;
  try {
    handle = await fs.open(sessionFile, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
  try {
    const length = Number(priorTailLength);
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, Number(position));
    if (BigInt(bytesRead) !== priorTailLength) {
      return undefined;
    }
    return {
      digest: createHash("sha256").update(buffer).digest("hex"),
      length: priorTailLength,
    };
  } finally {
    await handle.close();
  }
}

async function readSessionFileFingerprint(sessionFile: string): Promise<SessionFileFingerprint> {
  try {
    const stat = await fs.stat(sessionFile, { bigint: true });
    const tail = await readSessionFileTailDigest(sessionFile, stat.size);
    return {
      exists: true,
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
      tailDigest: tail.digest,
      tailLength: tail.length,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false };
    }
    throw err;
  }
}

async function waitForSessionEventQueue(session: unknown): Promise<void> {
  const owner = session as SessionEventQueueOwner;
  for (let attempts = 0; attempts < 5; attempts += 1) {
    const queue = owner?._agentEventQueue;
    if (!queue || typeof queue.then !== "function") {
      return;
    }
    await Promise.resolve(queue).catch(() => {});
    if (owner?._agentEventQueue === queue) {
      return;
    }
  }
  const queue = owner?._agentEventQueue;
  if (queue && typeof queue.then === "function") {
    await Promise.resolve(queue).catch(() => {});
  }
}

export class EmbeddedAttemptSessionTakeoverError extends Error {
  constructor(sessionFile: string) {
    super(`session file changed while embedded prompt lock was released: ${sessionFile}`);
    this.name = "EmbeddedAttemptSessionTakeoverError";
  }
}

export function installSessionEventWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionEventProcessor;
  const original = session._processAgentEvent;
  if (typeof original !== "function" || session.__openclawSessionEventWriteLockInstalled === true) {
    return;
  }
  session.__openclawSessionEventWriteLockInstalled = true;
  session._processAgentEvent = async function lockedProcessAgentEvent(
    this: unknown,
    event: unknown,
  ) {
    if (!eventMayReachTranscriptWriters(session, event)) {
      return await original.call(this, event);
    }
    return await params.withSessionWriteLock(async () => await original.call(this, event));
  };
}

export function installSessionExternalHookWriteLock(params: {
  session: unknown;
  withSessionWriteLock: <T>(run: () => Promise<T> | T) => Promise<T>;
}): void {
  const session = params.session as SessionWithExternalHooks;
  const agent = session.agent;
  if (agent) {
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "beforeToolCall",
      shouldLock: () => true,
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "afterToolCall",
      shouldLock: () => sessionHasExtensionHandlers(session, "tool_result"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onPayload",
      shouldLock: () => sessionHasExtensionHandlers(session, "before_provider_request"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
    installLockableFunction({
      owner: agent as Record<string, unknown>,
      key: "onResponse",
      shouldLock: () => sessionHasExtensionHandlers(session, "after_provider_response"),
      waitBeforeLock: () => waitForSessionEventQueue(session),
      withSessionWriteLock: params.withSessionWriteLock,
    });
  }
  installLockableFunction({
    owner: session as Record<string, unknown>,
    key: "compact",
    shouldLock: () => true,
    waitBeforeLock: () => waitForSessionEventQueue(session),
    withSessionWriteLock: params.withSessionWriteLock,
  });
}

export type EmbeddedAttemptSessionLockController = {
  releaseForPrompt(): Promise<void>;
  waitForSessionEvents(session: unknown): Promise<void>;
  withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T>;
  acquireForCleanup(params?: { session?: unknown }): Promise<SessionLock>;
  hasSessionTakeover(): boolean;
};

export async function createEmbeddedAttemptSessionLockController(params: {
  acquireSessionWriteLock: AcquireSessionWriteLock;
  lockOptions: LockOptions;
}): Promise<EmbeddedAttemptSessionLockController> {
  const acquireLock = async (): Promise<SessionLock> =>
    await params.acquireSessionWriteLock({
      sessionFile: params.lockOptions.sessionFile,
      timeoutMs: params.lockOptions.timeoutMs,
      staleMs: params.lockOptions.staleMs,
      maxHoldMs: params.lockOptions.maxHoldMs,
    });

  let heldLock: SessionLock | undefined = await acquireLock();
  const activeWriteLock = new AsyncLocalStorage<SessionLock>();
  let fenceFingerprint: SessionFileFingerprint | undefined;
  let fenceActive = false;
  let takeoverDetected = false;

  async function acquireWriteLock(): Promise<{ lock: SessionLock; owned: boolean }> {
    if (heldLock) {
      return { lock: heldLock, owned: false };
    }
    try {
      return { lock: await acquireLock(), owned: true };
    } catch (err) {
      if (isSessionWriteLockTimeoutError(err)) {
        takeoverDetected = true;
      }
      throw err;
    }
  }

  async function assertSessionFileFence(): Promise<void> {
    if (!fenceActive) {
      return;
    }
    const current = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    if (sameSessionFileFingerprint(fenceFingerprint, current)) {
      return;
    }
    // The stat-level fingerprint differs. Before declaring a takeover, check
    // whether the divergence is consistent with a pure append by another
    // legitimate writer that held the session write lock cleanly during the
    // released window (notably the outbound delivery-mirror path in
    // `appendAssistantMessageToSessionTranscript`). If the file is the same
    // inode, only grew, and the bytes that previously formed its tail are
    // still intact at the same offsets, we accept the change and refresh the
    // fence fingerprint forward.
    if (fenceFingerprint?.exists && current.exists) {
      const region = await readSessionFileRegionDigest(
        params.lockOptions.sessionFile,
        fenceFingerprint.size,
        fenceFingerprint.tailLength,
      );
      if (isPureAppendExtension(fenceFingerprint, current, region)) {
        fenceFingerprint = current;
        return;
      }
    }
    takeoverDetected = true;
    throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
  }

  async function refreshSessionFileFence(): Promise<void> {
    if (fenceActive && !takeoverDetected) {
      fenceFingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
    }
  }

  const noopLock: SessionLock = { release: async () => {} };

  return {
    async releaseForPrompt(): Promise<void> {
      if (!heldLock) {
        return;
      }
      const lock = heldLock;
      heldLock = undefined;
      fenceFingerprint = await readSessionFileFingerprint(params.lockOptions.sessionFile);
      fenceActive = true;
      await lock.release();
    },
    waitForSessionEvents: waitForSessionEventQueue,
    async withSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T> {
      if (takeoverDetected) {
        throw new EmbeddedAttemptSessionTakeoverError(params.lockOptions.sessionFile);
      }
      if (activeWriteLock.getStore()) {
        return await run();
      }
      const { lock, owned } = await acquireWriteLock();
      try {
        await assertSessionFileFence();
        const runWithLock = async () => {
          const result = await run();
          await refreshSessionFileFence();
          return result;
        };
        if (owned) {
          return await activeWriteLock.run(lock, runWithLock);
        }
        return await runWithLock();
      } finally {
        if (owned) {
          await lock.release();
        }
      }
    },
    async acquireForCleanup(cleanupParams?: { session?: unknown }): Promise<SessionLock> {
      if (cleanupParams?.session) {
        await waitForSessionEventQueue(cleanupParams.session);
      }
      if (takeoverDetected) {
        // Even though a takeover was detected, we may still be holding the
        // initial lock acquired in the constructor (this happens when the
        // attempt never reached `releaseForPrompt`, e.g. because the prompt
        // was skipped due to an early abort or precheck error). Returning
        // `noopLock` without releasing `heldLock` here is exactly the leak
        // that left orphaned `.jsonl.lock` files held by the gateway PID
        // until the 5-minute watchdog reclaimed them.
        if (heldLock) {
          const orphaned = heldLock;
          heldLock = undefined;
          return orphaned;
        }
        return noopLock;
      }
      try {
        heldLock ??= await acquireLock();
      } catch (err) {
        if (isSessionWriteLockTimeoutError(err)) {
          takeoverDetected = true;
          return noopLock;
        }
        throw err;
      }
      const cleanupLock = heldLock;
      heldLock = undefined;
      try {
        await assertSessionFileFence();
      } catch (err) {
        await cleanupLock.release();
        if (err instanceof EmbeddedAttemptSessionTakeoverError) {
          return noopLock;
        }
        throw err;
      }
      return cleanupLock;
    },
    hasSessionTakeover(): boolean {
      return takeoverDetected;
    },
  };
}

export function installPromptSubmissionLockRelease(params: {
  session: unknown;
  waitForSessionEvents: (session: unknown) => Promise<void>;
  releaseForPrompt: () => Promise<void>;
}): void {
  const agent = (params.session as SessionWithAgentPrompt).agent;
  if (typeof agent?.streamFn !== "function") {
    return;
  }
  const currentStreamFn = agent.streamFn;
  if (currentStreamFn.__openclawSessionLockPromptReleaseInstalled === true) {
    return;
  }
  const originalStreamFn = currentStreamFn.bind(agent);
  const wrappedStreamFn: PromptReleaseStreamFn = async (...args: unknown[]) => {
    await params.waitForSessionEvents(params.session);
    await params.releaseForPrompt();
    return await originalStreamFn(...args);
  };
  wrappedStreamFn.__openclawSessionLockPromptReleaseInstalled = true;
  agent.streamFn = wrappedStreamFn;
}

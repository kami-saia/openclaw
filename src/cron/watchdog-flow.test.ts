import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CronService } from "./service.js";

const noopLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

async function makeStorePath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-watchdog-"));
  return {
    storePath: path.join(dir, "cron", "jobs.json"),
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

describe("CronService Watchdog (Idle)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("bumps idle job execution time on activity", async () => {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();

    const cron = new CronService({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: enqueueSystemEvent as any,
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });

    await cron.start();

    // 1. Create Idle Job (timeout 2 min)
    const timeoutMs = 2 * 60 * 1000;
    const now = Date.now();
    await cron.add({
      name: "watchdog",
      enabled: true,
      schedule: { kind: "idle", timeoutMs, resetOn: ["user", "agent"] },
      // Use the object form for specific session targeting
      sessionTarget: { key: "session-123" },
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Are you there?" },
    });

    // 2. Verify initial schedule is set to Now + Timeout
    let jobs = await cron.list();
    let job = jobs[0];
    expect(job).toBeDefined();
    expect(job.state.nextRunAtMs).toBe(now + timeoutMs);

    // 3. Advance time by 1 minute (halfway)
    vi.advanceTimersByTime(60 * 1000);
    const midPoint = Date.now();

    // 4. Activity happens! Bump the job.
    await cron.bumpIdleJobs("user", "session-123");

    // 5. Verify nextRunAtMs is now MidPoint + Timeout
    jobs = await cron.list();
    job = jobs[0];
    expect(job.state.nextRunAtMs).toBe(midPoint + timeoutMs);

    // 6. Advance time past the NEW deadline? No, let's bump with WRONG session.
    vi.advanceTimersByTime(10 * 1000); // +10s
    // const wrongBumpPoint = Date.now();

    await cron.bumpIdleJobs("user", "session-999"); // Wrong session

    jobs = await cron.list();
    job = jobs[0];
    // Should NOT have moved relative to the *previous* bump.
    expect(job.state.nextRunAtMs).toBe(midPoint + timeoutMs);

    // 7. Bump with WRONG source (update job to only reset on "agent")
    await cron.update(job.id, { schedule: { kind: "idle", timeoutMs, resetOn: ["agent"] } });

    // Update resets timer to now + timeout
    const postUpdateNow = Date.now();
    jobs = await cron.list();
    job = jobs[0];
    expect(job.state.nextRunAtMs).toBe(postUpdateNow + timeoutMs);

    vi.advanceTimersByTime(10 * 1000);

    await cron.bumpIdleJobs("user", "session-123"); // Matching session, wrong source

    jobs = await cron.list();
    job = jobs[0];
    // Should NOT change from post-update value
    expect(job.state.nextRunAtMs).toBe(postUpdateNow + timeoutMs);

    cron.stop();
    await store.cleanup();
  });
});

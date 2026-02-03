import type { CronJobCreate, CronJobPatch } from "../types.js";
import {
  applyJobPatch,
  computeJobNextRunAtMs,
  createJob,
  findJobOrThrow,
  isJobDue,
  nextWakeAtMs,
  recomputeNextRuns,
} from "./jobs.js";
import { locked } from "./locked.js";
import type { CronServiceState } from "./state.js";
import { ensureLoaded, persist, warnIfDisabled } from "./store.js";
import { armTimer, emit, executeJob, stopTimer, wake } from "./timer.js";

export async function start(state: CronServiceState) {
  await locked(state, async () => {
    if (!state.deps.cronEnabled) {
      state.deps.log.info({ enabled: false }, "cron: disabled");
      return;
    }
    await ensureLoaded(state);
    recomputeNextRuns(state);
    await persist(state);
    armTimer(state);
    state.deps.log.info(
      {
        enabled: true,
        jobs: state.store?.jobs.length ?? 0,
        nextWakeAtMs: nextWakeAtMs(state) ?? null,
      },
      "cron: started",
    );
  });
}

export function stop(state: CronServiceState) {
  stopTimer(state);
}

export async function status(state: CronServiceState) {
  return await locked(state, async () => {
    await ensureLoaded(state);
    return {
      enabled: state.deps.cronEnabled,
      storePath: state.deps.storePath,
      jobs: state.store?.jobs.length ?? 0,
      nextWakeAtMs: state.deps.cronEnabled ? (nextWakeAtMs(state) ?? null) : null,
    };
  });
}

export async function list(state: CronServiceState, opts?: { includeDisabled?: boolean }) {
  return await locked(state, async () => {
    await ensureLoaded(state);
    const includeDisabled = opts?.includeDisabled === true;
    const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled);
    return jobs.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
  });
}

export async function add(state: CronServiceState, input: CronJobCreate) {
  return await locked(state, async () => {
    warnIfDisabled(state, "add");
    await ensureLoaded(state);
    const job = createJob(state, input);
    state.store?.jobs.push(job);
    await persist(state);
    armTimer(state);
    emit(state, {
      jobId: job.id,
      action: "added",
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

export async function update(state: CronServiceState, id: string, patch: CronJobPatch) {
  return await locked(state, async () => {
    warnIfDisabled(state, "update");
    await ensureLoaded(state);
    const job = findJobOrThrow(state, id);
    const now = state.deps.nowMs();
    applyJobPatch(job, patch);
    job.updatedAtMs = now;
    if (job.enabled) {
      job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
    } else {
      job.state.nextRunAtMs = undefined;
      job.state.runningAtMs = undefined;
    }

    await persist(state);
    armTimer(state);
    emit(state, {
      jobId: id,
      action: "updated",
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return job;
  });
}

export async function remove(state: CronServiceState, id: string) {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove");
    await ensureLoaded(state);
    const before = state.store?.jobs.length ?? 0;
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
    const removed = (state.store.jobs.length ?? 0) !== before;
    await persist(state);
    armTimer(state);
    if (removed) {
      emit(state, { jobId: id, action: "removed" });
    }
    return { ok: true, removed } as const;
  });
}

export async function run(state: CronServiceState, id: string, mode?: "due" | "force") {
  return await locked(state, async () => {
    warnIfDisabled(state, "run");
    await ensureLoaded(state);
    const job = findJobOrThrow(state, id);
    const now = state.deps.nowMs();
    const due = isJobDue(job, now, { forced: mode === "force" });
    if (!due) {
      return { ok: true, ran: false, reason: "not-due" as const };
    }
    await executeJob(state, job, now, { forced: mode === "force" });
    await persist(state);
    armTimer(state);
    return { ok: true, ran: true } as const;
  });
}

export function wakeNow(
  state: CronServiceState,
  opts: { mode: "now" | "next-heartbeat"; text: string },
) {
  return wake(state, opts);
}

export async function bumpIdleJobs(
  state: CronServiceState,
  source: "agent" | "user",
  sessionKey?: string,
) {
  return await locked(state, async () => {
    // No warning if disabled - this is a background housekeeping task
    if (!state.deps.cronEnabled) {
      return { ok: false };
    }
    await ensureLoaded(state);

    let changed = false;
    const now = state.deps.nowMs();

    for (const job of state.store?.jobs ?? []) {
      if (!job.enabled) continue;
      if (job.schedule.kind !== "idle") continue;

      // Filter by source (resetOn)
      // resetOn is array of "agent" | "user"
      if (!job.schedule.resetOn.includes(source)) continue;

      // Filter by session target
      // If sessionKey is provided, we must match it.
      // If job.sessionTarget is "main" or "isolated", it applies to ALL sessions of that type?
      // Actually, "idle" jobs should probably target a SPECIFIC sessionKey if possible.
      // But for now, let's assume sessionKey must match if job target specifies it.
      if (sessionKey) {
        if (
          typeof job.sessionTarget === "object" &&
          "key" in job.sessionTarget &&
          job.sessionTarget.key !== sessionKey
        ) {
          continue;
        }
        // If job targets "main" but event is from specific session, do we match?
        // Probably "main" implies the main session key (which we might not know here easily).
        // Let's assume if job has a specific key, we enforce it.
        // If job is "main"/"isolated", we might be bumping globally or mis-targeting.
        // For safety/MVP: Only bump if key matches OR job is generic.
        // Actually, let's say: if job has explicit key, it MUST match.
      }

      // Bump it!
      const newNextRun = now + Math.max(1000, job.schedule.timeoutMs);

      // Only write if it pushes it forward (or if it was undefined)
      if (!job.state.nextRunAtMs || newNextRun > job.state.nextRunAtMs) {
        job.state.nextRunAtMs = newNextRun;
        changed = true;
      }
    }

    if (changed) {
      // Persist and re-arm
      await persist(state);
      armTimer(state);
    }

    return { ok: true, bumped: changed };
  });
}

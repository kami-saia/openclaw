import { applyJobPatch, computeJobNextRunAtMs, createJob, findJobOrThrow, isJobDue, nextWakeAtMs, recomputeNextRuns, } from "./jobs.js";
import { locked } from "./locked.js";
import { ensureLoaded, persist, warnIfDisabled } from "./store.js";
import { armTimer, emit, executeJob, stopTimer, wake } from "./timer.js";
export async function start(state) {
    await locked(state, async () => {
        if (!state.deps.cronEnabled) {
            state.deps.log.info({ enabled: false }, "cron: disabled");
            return;
        }
        await ensureLoaded(state);
        recomputeNextRuns(state);
        await persist(state);
        armTimer(state);
        state.deps.log.info({
            enabled: true,
            jobs: state.store?.jobs.length ?? 0,
            nextWakeAtMs: nextWakeAtMs(state) ?? null,
        }, "cron: started");
    });
}
export function stop(state) {
    stopTimer(state);
}
export async function status(state) {
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
export async function list(state, opts) {
    return await locked(state, async () => {
        await ensureLoaded(state);
        const includeDisabled = opts?.includeDisabled === true;
        const jobs = (state.store?.jobs ?? []).filter((j) => includeDisabled || j.enabled);
        return jobs.toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));
    });
}
export async function add(state, input) {
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
export async function update(state, id, patch) {
    return await locked(state, async () => {
        warnIfDisabled(state, "update");
        await ensureLoaded(state);
        const job = findJobOrThrow(state, id);
        const now = state.deps.nowMs();
        applyJobPatch(job, patch);
        job.updatedAtMs = now;
        if (job.enabled) {
            job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
        }
        else {
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
export async function remove(state, id) {
    return await locked(state, async () => {
        warnIfDisabled(state, "remove");
        await ensureLoaded(state);
        const before = state.store?.jobs.length ?? 0;
        if (!state.store) {
            return { ok: false, removed: false };
        }
        state.store.jobs = state.store.jobs.filter((j) => j.id !== id);
        const removed = (state.store.jobs.length ?? 0) !== before;
        await persist(state);
        armTimer(state);
        if (removed) {
            emit(state, { jobId: id, action: "removed" });
        }
        return { ok: true, removed };
    });
}
export async function run(state, id, mode) {
    return await locked(state, async () => {
        warnIfDisabled(state, "run");
        await ensureLoaded(state);
        const job = findJobOrThrow(state, id);
        const now = state.deps.nowMs();
        const due = isJobDue(job, now, { forced: mode === "force" });
        if (!due) {
            return { ok: true, ran: false, reason: "not-due" };
        }
        await executeJob(state, job, now, { forced: mode === "force" });
        await persist(state);
        armTimer(state);
        return { ok: true, ran: true };
    });
}
export function wakeNow(state, opts) {
    return wake(state, opts);
}
export async function bumpIdleJobs(state, evt) {
    return await locked(state, async () => {
        if (!state.deps.cronEnabled) {
            return;
        }
        const { sessionKey, source } = evt;
        if (!sessionKey || !source) {
            return;
        }
        await ensureLoaded(state);
        const now = state.deps.nowMs();
        let changed = false;
        for (const job of state.store?.jobs ?? []) {
            if (!job.enabled)
                continue;
            if (job.schedule.kind !== "idle")
                continue;
            let matches = false;
            if (typeof job.sessionTarget === "object" && job.sessionTarget.key === sessionKey) {
                matches = true;
            }
            if (!matches)
                continue;
            // Handle stopOn logic: clear next run if stop signal received
            if (job.schedule.stopOn?.includes(source)) {
                // Do not disable the job (job.enabled = false), just disarm the timer.
                job.state.nextRunAtMs = undefined;
                job.state.runningAtMs = undefined;
                changed = true;
                continue;
            }
            if (!job.schedule.resetOn?.includes(source))
                continue;
            const next = now + (job.schedule.timeoutMs ?? 0);
            // Only update if significantly different (e.g. > 1s) to avoid thrashing on every token?
            // Actually, evt is transcript update (message level), so it's fine.
            if (job.state.nextRunAtMs !== next) {
                job.state.nextRunAtMs = next;
                // Also clear running status if it was stuck?
                job.state.runningAtMs = undefined;
                changed = true;
            }
        }
        if (changed) {
            await persist(state);
            armTimer(state);
        }
    });
}

import { createSubsystemLogger } from "../logging/subsystem.js";
export class StallDetector {
    config;
    deps;
    states = new Map();
    timer = null;
    logger = createSubsystemLogger("stall-detector");
    bootTimeMs = 0;
    constructor(config, deps) {
        this.config = config;
        this.deps = deps;
        this.bootTimeMs = deps.nowMs();
    }
    start() {
        if (!this.config.enabled)
            return;
        if (this.timer)
            clearInterval(this.timer);
        // Boot check: Immediately mark all sessions as IDLE (User Source) 
        // to start the timer, unless we know otherwise.
        // Ideally we would check session status, but here we assume safe default 
        // is to wait for the first user message. 
        // BUT the bug is that if we restart while idle, we wait for a NEW user message.
        // Fix: We can seed the state with "User Source" + "Now" for known sessions?
        // We don't have access to the session list here easily.
        // Alternative: Just start the timer loop. The loop iterates `this.states`.
        // If `this.states` is empty, nothing happens.
        // So we need to Populate `this.states` on startup!
        this.timer = setInterval(() => this.check(), 5000); // Check every 5s
        // this.logger.info("Stall detector started", { timeoutMs: this.config.timeoutMs });
    }
    onSessionLoaded(sessionKey) {
        // Called when gateway loads a session from disk or discovers it.
        // We assume it's SAFE (Agent Source) so we don't spam Idle Fox on restart.
        // The watchdog will ARM only when the User speaks or the Agent finishes a turn.
        if (!this.config.enabled)
            return;
        if (this.states.has(sessionKey))
            return; // Already tracking
        this.states.set(sessionKey, {
            sessionKey,
            lastActivityMs: this.deps.nowMs(),
            lastSource: "agent" // Start Disarmed
        });
        this.logger.debug("Stall detector tracking session", { sessionKey });
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    onTranscriptUpdate(evt) {
        if (!this.config.enabled || !evt.sessionKey || !evt.source)
            return;
        // Check for NO_REPLY signal
        // If agent says NO_REPLY, we treat it as Agent Activity (lastSource = agent).
        // This effectively disarms the watchdog until the next User message.
        const text = evt.text?.trim() || "";
        const isNoReply = evt.source === "agent" && (text === "NO_REPLY" || text === "HEARTBEAT_OK");
        const now = this.deps.nowMs();
        // Get existing state or default
        // CRITICAL: If state is missing, we default to "agent" (disarmed) and "now" (active).
        // This ensures that if the very first message we see is a system restart or noise,
        // the debounce logic below (checking < 1000ms) will trigger and ignore it.
        // If it's a real user message, the agent lifecycle events (start/end) will manage the state correctly.
        const state = this.states.get(evt.sessionKey) ?? {
            sessionKey: evt.sessionKey,
            lastActivityMs: now, // Was 0. Changing to now to enable debounce on startup.
            lastSource: "agent" // Default to safe state
        };
        if (evt.source === "user") {
            // Filter out system messages that don't trigger runs (e.g. GatewayRestart)
            // These messages set the state to "user" (armed) but no agent run follows, causing a false positive stall.
            // We check for various forms of restart messages.
            const text = evt.text || "";
            const isRestart = text.includes("GatewayRestart") ||
                text.includes('"kind": "restart"') ||
                text.includes('"kind":"restart"') ||
                (text.includes("restart") && text.includes("gateway"));
            // DEBOUNCE RESTART: If the message looks like a restart, ignore it.
            // BUT also check if the PREVIOUS message was a restart to avoid loops?
            if (isRestart) {
                this.logger.debug("Ignoring system restart message for stall detection", { key: evt.sessionKey });
                return;
            }
            // Debounce: If we JUST marked as Agent Activity (within 2000ms), 
            // ignore this User message if it is likely a race (e.g. system message arriving with agent start).
            // This protects against "Gateway Restart" or "Heartbeat" messages clobbering "Agent Started".
            if (state.lastSource === "agent" && (now - state.lastActivityMs) < 2000) {
                this.logger.debug("Ignoring user transcript update due to recent agent activity", { key: evt.sessionKey });
                return;
            }
            // GLOBAL BOOT DEBOUNCE: If the gateway just started (<15s ago), ignore user input unless it's clearly interactive.
            // This is a nuclear option to kill the "Zombie Fox" restart loop.
            // Restart messages can come in batches or delayed.
            if ((now - this.bootTimeMs) < 15000) {
                this.logger.debug("Ignoring user input during boot grace period", { key: evt.sessionKey, uptime: now - this.bootTimeMs });
                // We update the timestamp to prevent the old state from firing, but keep it as "agent" (disarmed) or previous state.
                this.states.set(evt.sessionKey, {
                    ...state,
                    lastActivityMs: now,
                    lastSource: "agent", // Force safety
                    lastTextPreview: "Boot Grace Period"
                });
                return;
            }
            this.states.set(evt.sessionKey, {
                ...state,
                lastActivityMs: now,
                lastSource: "user",
                lastTextPreview: text.substring(0, 50)
            });
            // DEBUG: Log exactly what text armed the watchdog
            this.logger.debug("Stall detector ARMED by user text", {
                key: evt.sessionKey,
                textSnippet: text.substring(0, 100),
                isRestartLike: isRestart
            });
        }
        else if (isNoReply) {
            // Disarm watchdog on NO_REPLY (Explicit completion)
            this.states.set(evt.sessionKey, {
                ...state,
                lastActivityMs: now,
                lastSource: "agent",
                lastTextPreview: "NO_REPLY"
            });
        }
        else if (evt.source === "agent") {
            // Agent is speaking/active.
            // DEBUG: Log agent text to diagnose NO_REPLY failure
            if (evt.text && evt.text.length < 20) {
                this.logger.debug("Agent text update", { key: evt.sessionKey, text: evt.text, isNoReply: evt.text.trim() === "NO_REPLY" });
            }
            // We update activity timestamp to RESET the timer.
            // We DO NOT change lastSource. If it was "user" (armed), it STAYS "user".
            // This ensures the watchdog fires if the agent stops speaking without saying "NO_REPLY".
            if (evt.text && evt.text.trim().length > 0) {
                this.states.set(evt.sessionKey, {
                    ...state,
                    lastActivityMs: now,
                    // lastSource preserved (e.g. "user")
                });
            }
        }
        // Note: Normal agent transcript updates (source="agent", text!="NO_REPLY") 
        // are NOT handled here to avoid race conditions with partial updates.
        // We rely on onAgentLifecycle (stream/start/end) for normal agent activity.
    }
    onAgentLifecycle(evt) {
        if (!this.config.enabled || !evt.sessionKey)
            return;
        const now = this.deps.nowMs();
        // Default to safe state (Agent active NOW) if unknown.
        // This prevents "End" events from unknown runs (e.g. after restart) from arming the watchdog immediately.
        const state = this.states.get(evt.sessionKey) ?? {
            sessionKey: evt.sessionKey,
            lastActivityMs: now,
            lastSource: "agent"
        };
        // DEBUG: Log the update
        this.logger.debug("onAgentLifecycle update", {
            key: evt.sessionKey,
            phase: evt.phase,
            oldSource: state.lastSource
        });
        if (evt.phase === "end" || evt.phase === "error") {
            // Agent finished turn.
            // BOOT GRACE PERIOD: If we just booted, this "end" event is likely cleanup from a pre-restart run.
            // We should NOT arm the watchdog. We should force DISARM (Agent Source).
            if ((now - this.bootTimeMs) < 15000) {
                this.logger.debug("Forcing DISARM on agent end during boot grace period", { key: evt.sessionKey });
                this.states.set(evt.sessionKey, {
                    ...state,
                    lastActivityMs: now,
                    lastSource: "agent",
                    lastTextPreview: "Boot Cleanup"
                });
                return;
            }
            // ARMS Watchdog (lastSource="user").
            // This forces the agent to explicitly sign off with NO_REPLY if done.
            // EXCEPTION: If we just explicitly DISARMED (e.g. via NO_REPLY in onTranscriptUpdate),
            // we should NOT re-arm.
            // NOTE: We check if lastSource is "agent" (disarmed) AND if the timestamp is recent.
            // However, onTranscriptUpdate for NO_REPLY sets lastActivityMs to NOW.
            // onAgentLifecycle also uses NOW.
            // So the diff will be near zero. 2000ms is a safe guard.
            if (state.lastSource === "agent" && (now - state.lastActivityMs) < 2000) {
                this.logger.debug("Skipping re-arm on agent end due to explicit disarm", { key: evt.sessionKey });
                return;
            }
            this.states.set(evt.sessionKey, {
                ...state,
                lastActivityMs: now,
                lastSource: "user",
                lastTextPreview: `Lifecycle: ${evt.phase}`
            });
        }
        else {
            // "start". Agent is working. 
            // Update timestamp to prevent timeout, but KEEP ARMED (preserve lastSource).
            // This ensures hangs during execution are caught.
            this.states.set(evt.sessionKey, {
                ...state,
                lastActivityMs: now,
                // lastSource preserved
            });
        }
    }
    async check() {
        const now = this.deps.nowMs();
        const threshold = this.config.timeoutMs;
        for (const [key, state] of this.states.entries()) {
            // DEBUG: Trace active checks
            if (state.lastSource === "user" && (now - state.lastActivityMs) > 5000) {
                this.logger.debug("Stall check pending", { key, elapsed: now - state.lastActivityMs });
            }
            // Only trigger if we are waiting for the AGENT (last source was User).
            if (state.lastSource !== "user") {
                continue;
            }
            const elapsed = now - state.lastActivityMs;
            if (elapsed > threshold) {
                // STALL DETECTED!
                this.logger.warn("Session stall detected", { sessionKey: key, elapsed, lastText: state.lastTextPreview });
                // Fire recovery heartbeat
                try {
                    const debugPrompt = `${this.config.prompt} (Trigger: ${state.lastTextPreview?.substring(0, 20) ?? "None"})`;
                    await this.deps.runHeartbeatOnce({
                        reason: "watchdog-stall",
                        prompt: debugPrompt,
                        sessionKey: key,
                    });
                    // Snooze: update activity to now so we don't spam.
                    // Note: The heartbeat itself will likely trigger a system event (User Source)
                    // and then Agent Start (Agent Source).
                    // If the agent starts, it will flip back to "agent" and we are good.
                    // If the agent fails to start, we will stay "user" and fire again in 30s.
                    state.lastActivityMs = now;
                    this.states.set(key, state);
                }
                catch (err) {
                    const errMsg = err instanceof Error ? err.message : String(err);
                    this.logger.error("Failed to fire recovery heartbeat", { err: errMsg, sessionKey: key });
                }
            }
        }
    }
}

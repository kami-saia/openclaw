import { createSubsystemLogger } from "../logging/subsystem.js";
export class ReplyChainEnforcer {
    config;
    deps;
    states = new Map();
    timer = null;
    logger = createSubsystemLogger("reply-chain");
    constructor(config, deps) {
        this.config = config;
        this.deps = deps;
    }
    start() {
        if (!this.config.enabled)
            return;
        if (this.timer)
            clearInterval(this.timer);
        this.timer = setInterval(() => this.check(), 5000);
    }
    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    onSessionLoaded(sessionKey) {
        if (!this.config.enabled)
            return;
        this.setState(sessionKey, "disarmed", "Session Loaded");
    }
    onTranscriptUpdate(evt) {
        if (!this.config.enabled || !evt.sessionKey || !evt.source)
            return;
        if (evt.source === "user")
            return;
        const text = evt.text?.trim() || "";
        const isSignOff = text === "NO_REPLY" || text === "HEARTBEAT_OK" || text.endsWith("NO_REPLY");
        if (isSignOff) {
            this.setState(evt.sessionKey, "disarmed", "NO_REPLY");
            this.logger.debug("Chain DISARMED by sign-off", { key: evt.sessionKey });
        }
        else {
            this.touchActivity(evt.sessionKey);
        }
    }
    onAgentLifecycle(evt) {
        if (!this.config.enabled || !evt.sessionKey)
            return;
        if (evt.phase === "start") {
            this.setState(evt.sessionKey, "armed", "Lifecycle Start");
        }
        else if (evt.phase === "end" || evt.phase === "error") {
            const state = this.states.get(evt.sessionKey);
            if (state?.status === "disarmed") {
                this.touchActivity(evt.sessionKey);
            }
            else {
                this.setState(evt.sessionKey, "armed", `Lifecycle End: ${evt.phase} (No Sign-off)`);
                this.logger.debug("Chain remains ARMED (No Sign-off)", { key: evt.sessionKey });
            }
        }
    }
    setState(sessionKey, status, reason) {
        this.states.set(sessionKey, {
            sessionKey,
            lastActivityMs: this.deps.nowMs(),
            status,
            lastTextPreview: reason
        });
    }
    touchActivity(sessionKey) {
        const state = this.states.get(sessionKey);
        if (state) {
            state.lastActivityMs = this.deps.nowMs();
            this.states.set(sessionKey, state);
        }
    }
    async check() {
        const now = this.deps.nowMs();
        const threshold = this.config.timeoutMs;
        for (const [key, state] of this.states.entries()) {
            if (state.status !== "armed")
                continue;
            const elapsed = now - state.lastActivityMs;
            if (elapsed > threshold) {
                this.logger.warn("Reply Chain broken", { sessionKey: key, elapsed, reason: state.lastTextPreview });
                try {
                    const debugPrompt = `${this.config.prompt} (Trigger: ${state.lastTextPreview})`;
                    await this.deps.runHeartbeatOnce({
                        reason: "reply-chain-broken",
                        prompt: debugPrompt,
                        sessionKey: key,
                    });
                    this.touchActivity(key);
                }
                catch (err) {
                    this.logger.error("Failed to fire recovery heartbeat", { err: String(err), sessionKey: key });
                }
            }
        }
    }
}

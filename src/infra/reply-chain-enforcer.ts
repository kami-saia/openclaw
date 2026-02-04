import type { HeartbeatRunResult } from "./heartbeat-wake.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

type ReplyChainStatus = "armed" | "disarmed";

type ReplyChainState = {
  lastActivityMs: number;
  sessionKey: string;
  status: ReplyChainStatus;
  lastTextPreview?: string;
};

type ReplyChainConfig = {
  enabled: boolean;
  timeoutMs: number;
  prompt: string;
};

export type ReplyChainDeps = {
  nowMs: () => number;
  runHeartbeatOnce: (opts: {
    reason: string;
    prompt: string;
    sessionKey: string;
  }) => Promise<HeartbeatRunResult>;
};

export class ReplyChainEnforcer {
  private states = new Map<string, ReplyChainState>();
  private timer: NodeJS.Timeout | null = null;
  private readonly logger = createSubsystemLogger("reply-chain");

  constructor(
    private config: ReplyChainConfig,
    private deps: ReplyChainDeps,
  ) {}

  public start() {
    if (!this.config.enabled) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.check(), 5000);
  }

  public stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public onSessionLoaded(sessionKey: string) {
    if (!this.config.enabled) return;
    this.setState(sessionKey, "disarmed", "Session Loaded");
  }

  public onTranscriptUpdate(evt: {
    sessionKey?: string;
    source?: "user" | "agent";
    text?: string;
  }) {
    if (!this.config.enabled || !evt.sessionKey || !evt.source) return;

    if (evt.source === "user") return;

    const text = evt.text?.trim() || "";
    const isSignOff = text === "NO_REPLY" || text === "HEARTBEAT_OK" || text.endsWith("NO_REPLY");

    if (isSignOff) {
      this.setState(evt.sessionKey, "disarmed", "NO_REPLY");
      this.logger.debug("Chain DISARMED by sign-off", { key: evt.sessionKey });
    } else {
      this.touchActivity(evt.sessionKey);
    }
  }

  public onAgentLifecycle(evt: { sessionKey?: string; phase: "start" | "end" | "error" }) {
    if (!this.config.enabled || !evt.sessionKey) return;

    if (evt.phase === "start") {
      this.setState(evt.sessionKey, "armed", "Lifecycle Start");
    } else if (evt.phase === "end" || evt.phase === "error") {
      const state = this.states.get(evt.sessionKey);

      if (state?.status === "disarmed") {
        this.touchActivity(evt.sessionKey);
      } else {
        this.setState(evt.sessionKey, "armed", `Lifecycle End: ${evt.phase} (No Sign-off)`);
        this.logger.debug("Chain remains ARMED (No Sign-off)", { key: evt.sessionKey });
      }
    }
  }

  private setState(sessionKey: string, status: ReplyChainStatus, reason: string) {
    this.states.set(sessionKey, {
      sessionKey,
      lastActivityMs: this.deps.nowMs(),
      status,
      lastTextPreview: reason,
    });
  }

  private touchActivity(sessionKey: string) {
    const state = this.states.get(sessionKey);
    if (state) {
      state.lastActivityMs = this.deps.nowMs();
      this.states.set(sessionKey, state);
    }
  }

  private async check() {
    const now = this.deps.nowMs();
    const threshold = this.config.timeoutMs;

    for (const [key, state] of this.states.entries()) {
      if (state.status !== "armed") continue;

      const elapsed = now - state.lastActivityMs;
      if (elapsed > threshold) {
        this.logger.warn("Reply Chain broken", {
          sessionKey: key,
          elapsed,
          reason: state.lastTextPreview,
        });

        try {
          const debugPrompt = `${this.config.prompt} (Trigger: ${state.lastTextPreview})`;
          await this.deps.runHeartbeatOnce({
            reason: "reply-chain-broken",
            prompt: debugPrompt,
            sessionKey: key,
          });
          this.touchActivity(key);
        } catch (err) {
          this.logger.error("Failed to fire recovery heartbeat", {
            err: String(err),
            sessionKey: key,
          });
        }
      }
    }
  }
}

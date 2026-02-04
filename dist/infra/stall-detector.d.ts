import type { HeartbeatRunResult } from "./heartbeat-wake.js";
type StallDetectorConfig = {
    enabled: boolean;
    timeoutMs: number;
    prompt: string;
};
export type StallDetectorDeps = {
    nowMs: () => number;
    runHeartbeatOnce: (opts: {
        reason: string;
        prompt: string;
        sessionKey: string;
    }) => Promise<HeartbeatRunResult>;
};
export declare class StallDetector {
    private config;
    private deps;
    private states;
    private timer;
    private readonly logger;
    private bootTimeMs;
    constructor(config: StallDetectorConfig, deps: StallDetectorDeps);
    start(): void;
    onSessionLoaded(sessionKey: string): void;
    stop(): void;
    onTranscriptUpdate(evt: {
        sessionKey?: string;
        source?: "user" | "agent";
        text?: string;
    }): void;
    onAgentLifecycle(evt: {
        sessionKey?: string;
        phase: "start" | "end" | "error";
    }): void;
    private check;
}
export {};

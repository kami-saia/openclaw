import type { HeartbeatRunResult } from "./heartbeat-wake.js";
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
export declare class ReplyChainEnforcer {
    private config;
    private deps;
    private states;
    private timer;
    private readonly logger;
    constructor(config: ReplyChainConfig, deps: ReplyChainDeps);
    start(): void;
    stop(): void;
    onSessionLoaded(sessionKey: string): void;
    onTranscriptUpdate(evt: {
        sessionKey?: string;
        source?: "user" | "agent";
        text?: string;
    }): void;
    onAgentLifecycle(evt: {
        sessionKey?: string;
        phase: "start" | "end" | "error";
    }): void;
    private setState;
    private touchActivity;
    private check;
}
export {};

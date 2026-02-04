export type SessionTranscriptUpdate = {
    sessionFile: string;
    source?: "agent" | "user";
    sessionKey?: string;
    text?: string;
};
type SessionTranscriptListener = (update: SessionTranscriptUpdate) => void;
export declare function onSessionTranscriptUpdate(listener: SessionTranscriptListener): () => void;
export declare function emitSessionTranscriptUpdate(sessionFile: string, opts?: {
    source?: "agent" | "user";
    sessionKey?: string;
    text?: string;
}): void;
export {};

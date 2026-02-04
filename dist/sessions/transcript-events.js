const SESSION_TRANSCRIPT_LISTENERS = new Set();
export function onSessionTranscriptUpdate(listener) {
    SESSION_TRANSCRIPT_LISTENERS.add(listener);
    return () => {
        SESSION_TRANSCRIPT_LISTENERS.delete(listener);
    };
}
export function emitSessionTranscriptUpdate(sessionFile, opts) {
    const trimmed = sessionFile.trim();
    if (!trimmed) {
        return;
    }
    const update = {
        sessionFile: trimmed,
        source: opts?.source,
        sessionKey: opts?.sessionKey,
        text: opts?.text,
    };
    for (const listener of SESSION_TRANSCRIPT_LISTENERS) {
        listener(update);
    }
}

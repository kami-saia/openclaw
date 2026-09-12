// FORK: on-demand streaming TTS route (tts.stream -> node voice.play).
// Kept out of server-http.ts so the fork's added route does not push that file
// past the 700-line max-lines cap; upstream's copy sits at 695 counted lines.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { VOICE_STREAM_PATH_PREFIX } from "./voice-stream-http.js";

const getVoiceStreamHttpModule = createLazyRuntimeModule(() => import("./voice-stream-http.js"));

/** True when the scoped request path targets the fork's voice-stream route. */
export function isVoiceStreamRequestPath(scopedRequestPath: string): boolean {
  return scopedRequestPath.startsWith(`${VOICE_STREAM_PATH_PREFIX}/`);
}

/**
 * Serves the fork's voice-stream route.
 *
 * The one-off path token is itself the capability, so this route authorizes on
 * possession of the URL rather than a gateway token: the player fetching it is a
 * media pipeline that cannot carry auth headers. Must stay ahead of the control-UI
 * SPA fallback, which would otherwise answer voice URLs with index.html.
 */
export async function handleVoiceStreamHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: OpenClawConfig,
): Promise<boolean> {
  return (await getVoiceStreamHttpModule()).handleVoiceStreamRequest(req, res, { config });
}

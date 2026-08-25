// On-demand streaming TTS route.
//
// A caller registers the text to speak and gets back an unguessable one-off path.
// When that path is fetched, the provider stream is opened and its bytes are piped
// straight to the HTTP response, so a client can start playing on the first chunk
// instead of waiting for a whole file to render, land on disk, and be re-served.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { OpenClawConfig } from "../config/types.js";
import { textToSpeechStream } from "../tts/runtime-api.js";
// Importing the TTS barrel installs the runtime availability guard and prefs resolver.
import "../tts/tts.js";

export const VOICE_STREAM_PATH_PREFIX = "/__openclaw__/voice-stream";
const VOICE_STREAM_TTL_MS = 5 * 60 * 1000;
const VOICE_STREAM_MAX_PENDING = 64;

type VoiceStreamEntry = {
  text: string;
  expiresAtMs: number;
  channel?: string;
  agentId?: string;
  accountId?: string;
};

const pendingVoiceStreams = new Map<string, VoiceStreamEntry>();

function prunePendingVoiceStreams(nowMs: number): void {
  for (const [id, entry] of pendingVoiceStreams) {
    if (entry.expiresAtMs <= nowMs) {
      pendingVoiceStreams.delete(id);
    }
  }
  // Bound memory even when nothing has expired yet: drop oldest insertions first.
  while (pendingVoiceStreams.size > VOICE_STREAM_MAX_PENDING) {
    const oldest = pendingVoiceStreams.keys().next();
    if (oldest.done) {
      break;
    }
    pendingVoiceStreams.delete(oldest.value);
  }
}

export function resolveVoiceStreamRoutePath(basePath?: string): string {
  const normalizedBasePath =
    basePath && basePath !== "/" ? (basePath.endsWith("/") ? basePath.slice(0, -1) : basePath) : "";
  return `${normalizedBasePath}${VOICE_STREAM_PATH_PREFIX}`;
}

/**
 * Register text for streaming synthesis. Returns the relative path to fetch.
 * The id is a 256-bit random token, so possession of the path is the capability;
 * no separate gateway token is required by the player.
 */
export function createVoiceStreamRequest(params: {
  text: string;
  channel?: string;
  agentId?: string;
  accountId?: string;
  basePath?: string;
  nowMs?: number;
}): { id: string; path: string; expiresAtMs: number } | null {
  const text = params.text.trim();
  if (!text) {
    return null;
  }
  const nowMs = params.nowMs ?? Date.now();
  prunePendingVoiceStreams(nowMs);
  const id = randomBytes(32).toString("base64url");
  const expiresAtMs = nowMs + VOICE_STREAM_TTL_MS;
  pendingVoiceStreams.set(id, {
    text,
    expiresAtMs,
    ...(params.channel ? { channel: params.channel } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  return { id, path: `${resolveVoiceStreamRoutePath(params.basePath)}/${id}`, expiresAtMs };
}

function resolveVoiceStreamEntry(id: string, nowMs: number): VoiceStreamEntry | null {
  const entry = pendingVoiceStreams.get(id);
  if (!entry) {
    return null;
  }
  if (entry.expiresAtMs <= nowMs) {
    pendingVoiceStreams.delete(id);
    return null;
  }
  return entry;
}

function resolveVoiceStreamContentType(fileExtension?: string): string {
  switch (fileExtension) {
    case ".opus":
    case ".ogg":
      return "audio/ogg";
    case ".wav":
      return "audio/wav";
    default:
      return "audio/mpeg";
  }
}

export async function handleVoiceStreamRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { basePath?: string; config?: OpenClawConfig },
): Promise<boolean> {
  const urlRaw = req.url;
  const method = req.method?.toUpperCase();
  if (!urlRaw || (method !== "GET" && method !== "HEAD")) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  const routePath = resolveVoiceStreamRoutePath(opts?.basePath);
  if (!url.pathname.startsWith(`${routePath}/`)) {
    return false;
  }
  const id = decodeURIComponent(url.pathname.slice(routePath.length + 1));
  const nowMs = Date.now();
  const entry = id ? resolveVoiceStreamEntry(id, nowMs) : null;
  if (!entry) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return true;
  }

  const cfg = opts?.config;
  if (!cfg) {
    res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Voice streaming unavailable");
    return true;
  }

  let release: (() => Promise<void>) | undefined;
  try {
    const result = await textToSpeechStream({
      text: entry.text,
      cfg,
      ...(entry.channel ? { channel: entry.channel } : {}),
      ...(entry.agentId ? { agentId: entry.agentId } : {}),
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
    });
    if (!result.success || !result.audioStream) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(result.error ?? "Streaming TTS failed");
      return true;
    }
    release = result.release;
    // No Content-Length: the length is unknown until the provider stream ends, and
    // withholding it is what lets the client begin playback on the first chunk.
    res.writeHead(200, {
      "Content-Type": resolveVoiceStreamContentType(result.fileExtension),
      "Cache-Control": "no-store",
      "Accept-Ranges": "none",
    });
    if (method === "HEAD") {
      res.end();
      await release?.();
      return true;
    }
    await pipeline(
      Readable.fromWeb(result.audioStream as unknown as NodeWebReadableStream<Uint8Array>),
      res,
    );
    return true;
  } catch {
    await release?.().catch(() => {});
    if (res.headersSent) {
      res.destroy();
    } else {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Voice streaming failed");
    }
    return true;
  }
}

/** Test seam: clears registered pending streams. */
export function __resetVoiceStreamsForTest(): void {
  pendingVoiceStreams.clear();
}

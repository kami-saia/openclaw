import { appendFileSync, readFileSync } from "node:fs";
import type { EasyInputMessage } from "openai/resources/responses/responses.js";
import { stripSystemPromptCacheBoundary } from "../utils/system-prompt-cache-boundary.js";
import {
  responsesPromptObserver,
  type ResponsesPromptObservation,
} from "./openai-responses-contracts.js";
import { sanitizeTransportPayloadText } from "./transport-stream-shared.js";

type ResponsesPromptRequest = { instructions?: unknown; input?: unknown };
type ResponsesPromptMetadata = Pick<ResponsesPromptObservation, "egress" | "payloadVariant">;

function readFinalResponsesPrompt(
  request: ResponsesPromptRequest,
): [ResponsesPromptObservation["promptSource"], string] {
  if (typeof request.instructions === "string") {
    return ["instructions", request.instructions] as const;
  }
  const input = Array.isArray(request.input) ? request.input : [];
  const message = input.find((item) => {
    const role = (item as EasyInputMessage).role;
    return role === "developer" || role === "system";
  }) as EasyInputMessage | undefined;
  if (!message) {
    return ["missing", ""] as const;
  }
  const content = message.content;
  const observedPrompt =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => (part.type === "input_text" ? [part.text] : [])).join("")
        : "";
  return [
    message.role === "developer" ? "input.developer" : "input.system",
    observedPrompt,
  ] as const;
}

/**
 * Diagnostic: dump the real outbound Responses payload role structure.
 *
 * Enabled only when `OPENCLAW_EGRESS_PAYLOAD_DUMP` names a writable file path.
 * Writes one JSON line per request: every instruction-bearing message with its
 * role, content length, and a bounded prefix. This is the only trustworthy
 * answer to "what roles does the provider actually receive?" — model
 * self-report of its own prompt roles is confabulation-prone and unusable.
 */
const EGRESS_DUMP_CONTROL_FILE = "/home/damon/.openclaw/workspace/tmp/egress-dump-target";

function readEgressDumpPath(): string | undefined {
  const raw = process.env.OPENCLAW_EGRESS_PAYLOAD_DUMP;
  if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  // Fallback: a control file. The gateway runs under a systemd user unit whose
  // manager is unreachable from the agent's mount namespace, so its Environment=
  // cannot be reloaded. Presence of this file enables the dump; its contents are
  // the destination path. Delete the file to turn the dump off.
  const now = Date.now();
  if (now - egressControlCheckedAt < EGRESS_CONTROL_TTL_MS) return egressControlCached;
  egressControlCheckedAt = now;
  try {
    const fromFile = readFileSync(EGRESS_DUMP_CONTROL_FILE, "utf8").trim();
    egressControlCached = fromFile.length > 0 ? fromFile : undefined;
  } catch {
    egressControlCached = undefined;
  }
  return egressControlCached;
}

const EGRESS_CONTROL_TTL_MS = 5000;
let egressControlCheckedAt = 0;
let egressControlCached: string | undefined;

const EGRESS_DUMP_PREFIX_CHARS = 400;

function describeEgressContent(content: unknown): { chars: number; prefix: string } {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.flatMap((part) => (isEgressTextPart(part) ? [part.text] : [])).join("")
        : "";
  return { chars: text.length, prefix: text.slice(0, EGRESS_DUMP_PREFIX_CHARS) };
}

function isEgressTextPart(part: unknown): part is { type: string; text: string } {
  if (typeof part !== "object" || part === null) {
    return false;
  }
  const candidate = part as { type?: unknown; text?: unknown };
  return typeof candidate.text === "string" && typeof candidate.type === "string";
}

function dumpResponsesEgressPayload(
  request: ResponsesPromptRequest,
  metadata: ResponsesPromptMetadata,
): void {
  const path = readEgressDumpPath();
  if (!path) {
    return;
  }
  try {
    const input = Array.isArray(request.input) ? request.input : [];
    const messages = input.flatMap((item) => {
      const message = item as { role?: unknown; content?: unknown; type?: unknown };
      if (typeof message.role !== "string") {
        return [];
      }
      const described = describeEgressContent(message.content);
      return [{ role: message.role, chars: described.chars, prefix: described.prefix }];
    });
    const instructions =
      typeof request.instructions === "string"
        ? {
            chars: request.instructions.length,
            prefix: request.instructions.slice(0, EGRESS_DUMP_PREFIX_CHARS),
          }
        : undefined;
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      egress: metadata.egress,
      payloadVariant: metadata.payloadVariant,
      instructions,
      messageRoles: messages.map((message) => message.role),
      messages,
    })}\n`;
    appendFileSync(path, line, "utf-8");
  } catch {
    // Diagnostics must never break a live request.
  }
}

export function createResponsesPromptEgressObserver(
  options: object | undefined,
  assembledPrompt: string | undefined,
) {
  const observer = options ? responsesPromptObserver.get(options) : undefined;
  const dumpEnabled = readEgressDumpPath() !== undefined;
  if (!observer && !dumpEnabled) {
    return undefined;
  }
  const expectedPrompt = sanitizeTransportPayloadText(
    stripSystemPromptCacheBoundary(assembledPrompt ?? ""),
  );
  return (request: ResponsesPromptRequest, metadata: ResponsesPromptMetadata) => {
    dumpResponsesEgressPayload(request, metadata);
    if (!observer) {
      return;
    }
    const [promptSource, observedPrompt] = readFinalResponsesPrompt(request);
    observer({
      ...metadata,
      promptSource,
      expectedChars: expectedPrompt.length,
      observedChars: observedPrompt.length,
      matchesAssembledPrompt: promptSource !== "missing" && observedPrompt === expectedPrompt,
    });
  };
}

// FORK: snapshot-collapse text_end emission for the OpenAI Responses stream.
// Extracted from openai-responses-stream-internal.ts so the fork's duplicate-reply
// guard does not push that file past the 700-line max-lines cap; upstream's copy
// sits at 698 counted lines.
import type { AssistantMessage } from "../types.js";
import type {
  ResponsesEventSink,
  TextBlockReference,
} from "./openai-responses-stream-terminal-internal.js";

/**
 * Replaces a collapsed message block's text and re-ends it only when the text
 * actually changed.
 *
 * A pure repeat adds no text; re-ending the block would deliver the same reply
 * twice downstream (one chat message per text_end).
 */
export function applyResponsesSnapshotCollapse(params: {
  stream: ResponsesEventSink;
  candidate: TextBlockReference;
  text: string;
  textSignature: string;
  partial: AssistantMessage;
}): void {
  const { stream, candidate, text, textSignature, partial } = params;
  const priorText = candidate.block.text;
  candidate.block.text = text;
  candidate.block.textSignature = textSignature;
  if (text === priorText) {
    return;
  }
  stream.push({
    type: "text_end",
    contentIndex: candidate.index,
    content: text,
    partial,
  });
}

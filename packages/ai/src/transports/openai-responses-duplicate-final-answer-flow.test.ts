import { describe, expect, it } from "vitest";
import { completed, runFixture } from "./openai-responses-stream-parity.test-helpers.js";

// A Responses turn must project one assistant answer per final answer the model
// produced, regardless of how many `message` output items the provider chose to
// emit for it. Downstream delivery sends one chat message per text block, so an
// extra block is a duplicate reply to the user.
const FINAL = "Got it — this is the clone-reply test on GPT. I'm sending exactly one response.";

const messageItem = (id: string, text: string, status: string) => ({
  id,
  type: "message",
  role: "assistant",
  status,
  phase: "final_answer",
  content: [{ type: "output_text", text, annotations: [] }],
});

describe("Responses final answer projection", () => {
  it("projects a single text block when the provider repeats the final answer item", async () => {
    const result = await runFixture([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_0", type: "reasoning", summary: [], content: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: "rs_0",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking" }],
          content: [],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...messageItem("msg_first", "", "in_progress"), content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 1,
        item_id: "msg_first",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        item_id: "msg_first",
        content_index: 0,
        delta: FINAL,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: messageItem("msg_first", FINAL, "completed"),
      },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { ...messageItem("msg_repeat", "", "in_progress"), content: [] },
      },
      {
        type: "response.content_part.added",
        output_index: 2,
        item_id: "msg_repeat",
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 2,
        item_id: "msg_repeat",
        content_index: 0,
        delta: FINAL,
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: messageItem("msg_repeat", FINAL, "completed"),
      },
      completed("resp_repeated_final", [
        {
          id: "rs_0",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "thinking" }],
          content: [],
        },
        messageItem("msg_first", FINAL, "completed"),
        messageItem("msg_repeat", FINAL, "completed"),
      ]),
    ]);

    expect(result.error).toBeNull();
    expect(result.content.filter((block) => block.type === "text")).toEqual([
      { type: "text", text: FINAL },
    ]);
    expect(result.events.filter((event) => event.type === "text_end")).toEqual([
      { type: "text_end", contentIndex: 1, content: FINAL },
    ]);
  });

  it("keeps distinct final answer items that carry different text", async () => {
    const result = await runFixture([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...messageItem("msg_a", "", "in_progress"), phase: "commentary", content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_a",
        content_index: 0,
        delta: "first",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { ...messageItem("msg_a", "first", "completed"), phase: "commentary" },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...messageItem("msg_b", "", "in_progress"), content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        item_id: "msg_b",
        content_index: 0,
        delta: "second",
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: messageItem("msg_b", "second", "completed"),
      },
      completed("resp_distinct"),
    ]);

    expect(result.error).toBeNull();
    expect(result.content.filter((block) => block.type === "text")).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });
});

// Regression (#eyrie-triple): the provider streamed reasoning + one final-answer
// message item, then the terminal snapshot carried a *second* message item with
// the same text under a different id. Terminal recovery must still collapse it.
describe("Responses terminal recovery final answer projection", () => {
  it("collapses a duplicate final answer item that only appears in the terminal snapshot", async () => {
    const reasoning = {
      id: "rs_0",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "thinking" }],
      content: [],
    };
    const result = await runFixture([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "rs_0", type: "reasoning", summary: [], content: [] },
      },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { ...messageItem("msg_first", "", "in_progress"), content: [] },
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        item_id: "msg_first",
        content_index: 0,
        delta: FINAL,
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: messageItem("msg_first", FINAL, "completed"),
      },
      completed("resp_terminal_repeat", [
        reasoning,
        messageItem("msg_first", FINAL, "completed"),
        messageItem("msg_repeat", FINAL, "completed"),
      ]),
    ]);

    expect(result.error).toBeNull();
    expect(result.content.filter((block) => block.type === "text")).toEqual([
      { type: "text", text: FINAL },
    ]);
  });
});

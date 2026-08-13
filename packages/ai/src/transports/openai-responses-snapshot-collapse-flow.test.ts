import { describe, expect, it } from "vitest";
import { completed, runFixture } from "./openai-responses-stream-parity.test-helpers.js";

// Flow-level: a provider that re-emits the assistant reply as repeated message
// snapshots must still produce exactly one visible answer.
const messageItem = (id: string, text: string, status = "completed") => ({
  id,
  type: "message",
  role: "assistant",
  status,
  content: [{ type: "output_text", text, annotations: [] }],
});

const textOf = (content: { type: string; text?: string }[]) =>
  content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

describe("Responses assistant reply is emitted once", () => {
  it("collapses a re-emitted identical message snapshot", async () => {
    const result = await runFixture([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: "msg_0",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      {
        type: "response.output_text.delta",
        output_index: 0,
        item_id: "msg_0",
        content_index: 0,
        delta: "Chime",
      },
      { type: "response.output_item.done", output_index: 0, item: messageItem("msg_0", "Chime") },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      },
      { type: "response.output_item.done", output_index: 1, item: messageItem("msg_1", "Chime") },
      completed("resp_dup", [messageItem("msg_0", "Chime"), messageItem("msg_1", "Chime")]),
    ]);

    expect(result.error).toBeNull();
    expect(result.content.filter((block) => block.type === "text")).toHaveLength(1);
    expect(textOf(result.content as { type: string; text?: string }[])).toBe("Chime");
  });

  it("collapses identical message snapshots recovered from the terminal response", async () => {
    const result = await runFixture([
      completed("resp_terminal_dup", [
        messageItem("msg_0", "Chime"),
        messageItem("msg_1", "Chime"),
      ]),
    ]);

    expect(result.error).toBeNull();
    expect(result.content.filter((block) => block.type === "text")).toHaveLength(1);
    expect(textOf(result.content as { type: string; text?: string }[])).toBe("Chime");
  });

  it("keeps genuinely distinct assistant messages separate", async () => {
    const result = await runFixture([
      completed("resp_distinct", [messageItem("msg_0", "first"), messageItem("msg_1", "second")]),
    ]);

    expect(result.error).toBeNull();
    expect(result.content.filter((block) => block.type === "text")).toHaveLength(2);
    expect(textOf(result.content as { type: string; text?: string }[])).toBe("firstsecond");
  });
});

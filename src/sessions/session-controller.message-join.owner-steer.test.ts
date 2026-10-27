import { expect, it } from "vitest";
import { createQueueTestRun } from "../auto-reply/reply/queue.test-helpers.js";
import type { ReplyOperation } from "./session-controller.contracts.js";
import { hasReplySteeringRequesterMismatch } from "./session-controller.message-join.js";

// FORK: owner may steer a requester-less (system wake) turn; strangers may not.
function run(senderIsOwner: boolean) {
  return createQueueTestRun(
    { prompt: "steer" },
    { messageProvider: "discord", senderId: "u1", senderIsOwner },
  );
}
const systemTurn = { requesterPrincipalKey: undefined } as unknown as ReplyOperation;
const otherHumanTurn = {
  requesterPrincipalKey: JSON.stringify(["discord", "default", "u2"]),
} as unknown as ReplyOperation;

it("lets the owner steer a turn with no human requester", () => {
  expect(hasReplySteeringRequesterMismatch(run(true), systemTurn)).toBe(false);
});

it("still refuses non-owners on a requester-less turn", () => {
  expect(hasReplySteeringRequesterMismatch(run(false), systemTurn)).toBe(true);
});

it("still refuses the owner on another human's turn", () => {
  expect(hasReplySteeringRequesterMismatch(run(true), otherHumanTurn)).toBe(true);
});

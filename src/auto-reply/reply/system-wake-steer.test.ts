import { expect, it } from "vitest";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { allowsOwnerSystemWakeSteer } from "./system-wake-steer.js";

// FORK: owner may steer a system wake despite retained terminal tombstones.
const run = (senderIsOwner: boolean) =>
  createQueueTestRun({ prompt: "steer" }, { messageProvider: "discord", senderIsOwner });
const wake = { requesterPrincipalKey: undefined } as unknown as ReplyOperation;
const human = { requesterPrincipalKey: "k" } as unknown as ReplyOperation;
const reason = "unknown-source-with-terminal-history";

it("lets the owner steer a requester-less turn past tombstone history", () => {
  expect(allowsOwnerSystemWakeSteer(reason, run(true), wake)).toBe(true);
});

it("keeps failing closed otherwise", () => {
  expect(allowsOwnerSystemWakeSteer(reason, run(false), wake)).toBe(false);
  expect(allowsOwnerSystemWakeSteer(reason, run(true), human)).toBe(false);
  expect(allowsOwnerSystemWakeSteer(reason, run(true), undefined)).toBe(false);
  expect(allowsOwnerSystemWakeSteer("delivery-ambiguous", run(true), wake)).toBe(false);
});

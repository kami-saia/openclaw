// FORK: node-role clients must not receive chat/agent broadcasts.
// Lives in its own file because gateway-misc.test.ts is at the max-lines ratchet.
import { describe, expect, it, vi } from "vitest";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type RecordingSocket = {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function makeRecordingSocket(): RecordingSocket {
  return {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn(),
    close: vi.fn(),
    terminate: vi.fn(),
  };
}

function makeClient(
  connId: string,
  socket: RecordingSocket,
  connect: GatewayWsClient["connect"],
): GatewayWsClient {
  return {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect,
    connId,
    usesSharedGatewayAuth: false,
  };
}

describe("gateway broadcaster node exclusion", () => {
  it("excludes chat/agent events from node-role clients", () => {
    const operatorSocket = makeRecordingSocket();
    const nodeSocket = makeRecordingSocket();

    const clients = new Set<GatewayWsClient>([
      makeClient("c-operator", operatorSocket, {
        role: "operator",
        scopes: ["operator.admin"],
      } as GatewayWsClient["connect"]),
      makeClient("c-node", nodeSocket, {
        role: "node",
        scopes: [],
      } as unknown as GatewayWsClient["connect"]),
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("chat", { runId: "r1", state: "delta" });
    broadcast("chat.side_result", { runId: "r1" });
    broadcast("agent", { sessionKey: "main" });

    // Node should NOT receive chat/agent broadcasts (NODE_EXCLUDED_EVENTS gate)
    expect(nodeSocket.send).toHaveBeenCalledTimes(0);
    // Operator-admin should receive all three
    expect(operatorSocket.send).toHaveBeenCalledTimes(3);

    // Non-excluded events like tick should still reach nodes
    broadcast("tick", { ts: 1 });
    expect(nodeSocket.send).toHaveBeenCalledTimes(1);
    expect(operatorSocket.send).toHaveBeenCalledTimes(4);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCopilotRuntimeAuth } from "./runtime-auth.js";

// FORK: optional CAPI exchange must not discard a valid source credential.
describe("optional Copilot token exchange", () => {
  afterEach(() => vi.restoreAllMocks());

  it("preserves an aborted auth deadline during exchange", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const failure = new DOMException("exchange deadline", "TimeoutError");
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
      )
      .mockImplementationOnce(async () => {
        controller.abort(failure);
        throw failure;
      });
    await expect(
      resolveCopilotRuntimeAuth({ githubToken: "source-token", fetchImpl, env: {} }),
    ).rejects.toMatchObject({ reason: "timeout", cause: failure });
  });
  it.each(["transport", "http", "invalid"])("falls back after %s failure", async (failure) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
      );
    if (failure === "transport") {
      fetchImpl.mockRejectedValueOnce(new TypeError("exchange unavailable"));
    } else {
      fetchImpl.mockResolvedValueOnce(
        failure === "http" ? new Response(null, { status: 403 }) : Response.json({}),
      );
    }
    await expect(
      resolveCopilotRuntimeAuth({ githubToken: "source-token", fetchImpl, env: {} }),
    ).resolves.toEqual({
      apiKey: "source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("prefers a successful exchange", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ endpoints: { api: "https://api.individual.githubcopilot.com" } }),
      )
      .mockResolvedValueOnce(Response.json({ token: "exchanged-token", expires_at: 2000000000 }));
    await expect(
      resolveCopilotRuntimeAuth({ githubToken: "source-token", fetchImpl, env: {} }),
    ).resolves.toMatchObject({
      apiKey: "exchanged-token",
      expiresAt: 2000000000000,
    });
  });

  it("does not hide source credential lookup failures", async () => {
    const failure = new TypeError("user endpoint unavailable");
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(failure);
    await expect(
      resolveCopilotRuntimeAuth({ githubToken: "source-token", fetchImpl, env: {} }),
    ).rejects.toBe(failure);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

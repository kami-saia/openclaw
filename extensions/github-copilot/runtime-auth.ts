// GitHub Copilot source-token validation and account endpoint resolution.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { PUBLIC_GITHUB_COPILOT_DOMAIN, resolveGithubCopilotDomain } from "./domain.js";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";

export const DEFAULT_COPILOT_API_BASE_URL = "https://api.individual.githubcopilot.com";
const COPILOT_RUNTIME_AUTH_TIMEOUT_MS = 30_000;

function copilotUserUrl(domain: string): string {
  return `https://api.${domain}/copilot_internal/user`;
}

function copilotApiBaseFallback(domain: string): string {
  return domain === PUBLIC_GITHUB_COPILOT_DOMAIN
    ? DEFAULT_COPILOT_API_BASE_URL
    : `https://copilot-api.${domain}`;
}

function isTrustedCopilotApiHost(host: string, domain: string): boolean {
  if (host === "copilot-proxy.githubusercontent.com" || host.endsWith(".githubcopilot.com")) {
    return true;
  }
  return (
    domain !== PUBLIC_GITHUB_COPILOT_DOMAIN && (host === domain || host.endsWith(`.${domain}`))
  );
}

function parseCopilotApiBaseUrl(value: unknown, domain: string): string {
  if (!value || typeof value !== "object") {
    throw new Error("Unexpected response from GitHub Copilot user endpoint");
  }
  // SAFETY: guarded by the object typeof check above; property read stays unknown.
  const endpoints = (value as { endpoints?: unknown }).endpoints;
  const api =
    endpoints && typeof endpoints === "object"
      ? // SAFETY: guarded by the typeof check in this same expression.
        (endpoints as { api?: unknown }).api
      : undefined;
  if (api === undefined || api === null || api === "") {
    return copilotApiBaseFallback(domain);
  }
  if (typeof api !== "string" || !api.trim()) {
    throw new Error("GitHub Copilot user response has an invalid endpoints.api URL");
  }
  let url: URL;
  try {
    url = new URL(api);
  } catch {
    throw new Error("GitHub Copilot user response has an invalid endpoints.api URL");
  }
  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !isTrustedCopilotApiHost(host, domain)
  ) {
    throw new Error("GitHub Copilot user response has an untrusted endpoints.api URL");
  }
  return url.href.replace(/\/+$/, "");
}

function copilotTokenUrl(domain: string): string {
  return `https://api.${domain}/copilot_internal/v2/token`;
}

/**
 * Enterprise CAPI rejects raw `ghu_` bearers non-deterministically (~2/3 of
 * requests) with a Terms of Service 403, so exchange for a CAPI token first.
 */
async function exchangeCopilotApiToken(params: {
  githubToken: string;
  domain: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<{ apiKey: string; baseUrl?: string; expiresAt?: number } | undefined> {
  const response = await params.fetchImpl(copilotTokenUrl(params.domain), {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${params.githubToken}`,
      "Editor-Version": "vscode/1.107.0",
    },
    signal: params.signal,
  });
  if (!response.ok) {
    if (!response.bodyUsed) {
      void response.body?.cancel().catch(() => undefined);
    }
    return undefined;
  }
  const payload = await readProviderJsonResponse(response, "github-copilot.token");
  // SAFETY: readProviderJsonResponse returns parsed JSON; value validated as string below.
  const token = (payload as { token?: unknown }).token;
  if (typeof token !== "string" || !token.trim()) {
    return undefined;
  }
  // SAFETY: readProviderJsonResponse returns parsed JSON; value re-validated before use.
  const expiresAtSeconds = (payload as { expires_at?: unknown }).expires_at;
  let baseUrl: string | undefined;
  try {
    baseUrl = parseCopilotApiBaseUrl(payload, params.domain);
  } catch {
    baseUrl = undefined;
  }
  return {
    apiKey: token,
    baseUrl,
    expiresAt: typeof expiresAtSeconds === "number" ? expiresAtSeconds * 1000 : undefined,
  };
}

export async function resolveCopilotRuntimeAuth(params: {
  githubToken: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  githubDomain?: string;
  config?: OpenClawConfig;
}): Promise<{
  apiKey: string;
  source: string;
  baseUrl: string;
  expiresAt?: number;
}> {
  const env = params.env ?? process.env;
  const domain = resolveGithubCopilotDomain({
    env,
    explicit: params.githubDomain,
    config: params.config,
  });
  const userUrl = copilotUserUrl(domain);
  const fetchImpl = params.fetchImpl ?? fetch;
  const signal = AbortSignal.timeout(COPILOT_RUNTIME_AUTH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(userUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.githubToken}`,
      },
      signal,
    });
    if (!response.ok) {
      // A capture tee must not delay the already-known authentication failure.
      if (!response.bodyUsed) {
        void response.body?.cancel().catch(() => undefined);
      }
      throw new CopilotRuntimeAuthError({ reason: "http_error", status: response.status });
    }
    const baseUrl = parseCopilotApiBaseUrl(
      await readProviderJsonResponse(response, "github-copilot.user"),
      domain,
    );
    const exchanged = await exchangeCopilotApiToken({
      githubToken: params.githubToken,
      domain,
      fetchImpl,
      signal,
    });
    if (exchanged) {
      return {
        apiKey: exchanged.apiKey,
        source: `exchanged:${copilotTokenUrl(domain)}`,
        baseUrl: exchanged.baseUrl ?? baseUrl,
        expiresAt: exchanged.expiresAt,
      };
    }
    // Fine-grained PATs are rejected by the exchange, so fall back to the raw
    // token the way the Copilot CLI/SDK does.
    return {
      apiKey: params.githubToken,
      source: `validated:${userUrl}`,
      baseUrl,
    };
  } catch (error) {
    if (signal.aborted) {
      throw new CopilotRuntimeAuthError({
        reason: "timeout",
        timeoutMs: COPILOT_RUNTIME_AUTH_TIMEOUT_MS,
        cause: error,
      });
    }
    throw error;
  }
}

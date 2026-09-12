import type { DesktopSource, WorkerDesktopLaunchResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { DesktopAppId } from "./desktop-panel-connection.ts";

/** Result of a desktop app launch attempt. `stale` means a newer launch superseded this one. */
export type DesktopLaunchOutcome = { errorText: string | null; stale: boolean };

/**
 * Issues `desktop.launch` and resolves the launch race.
 *
 * `isStale` is re-checked after the request settles so a superseded launch never
 * writes its error or clears the pending state belonging to a newer one.
 */
export async function requestDesktopAppLaunch(opts: {
  client: GatewayBrowserClient;
  source: DesktopSource;
  app: DesktopAppId;
  isStale: () => boolean;
}): Promise<DesktopLaunchOutcome> {
  try {
    await opts.client.request<WorkerDesktopLaunchResult>("desktop.launch", {
      source: opts.source,
      app: opts.app,
    });
    return { errorText: null, stale: opts.isStale() };
  } catch (error) {
    if (opts.isStale()) {
      return { errorText: null, stale: true };
    }
    return { errorText: formatUiError(error), stale: false };
  }
}

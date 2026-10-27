import type { InternalSessionEntry } from "../config/sessions/types.js";
import { captureQueuedOperatorRecoverySource } from "../gateway/operator-run-recovery-source.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import {
  captureRequesterOrigin,
  decodeRequesterOrigin,
  resolveRequesterPrincipalKey,
  type RequesterOrigin,
} from "./requester-origin.js";

/** Facts retained by the existing restart claim, never an execution grant. */
export type RestartRecoveryRequesterSource = Readonly<{
  agentId: string;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision?: string;
  sourceRunId: string;
  requesterOrigin: RequesterOrigin;
  /**
   * FORK: linked channel operator basis for the same requester. Restoration re-prepares
   * the exact authorization reference under current config; this is never a grant.
   */
  channelOperator?: unknown;
}>;

function captureChannelOperatorBasis(
  authority: AdmittedRunOperatorAuthority | undefined,
  requesterOrigin: RequesterOrigin,
): { channelOperator?: unknown } {
  if (!authority || !requesterOrigin.operatorProfileId) {
    return {};
  }
  if (requesterOrigin.operatorProfileId !== authority.profileId) {
    return {};
  }
  const captured = captureQueuedOperatorRecoverySource(authority);
  return captured?.kind === "channel" ? { channelOperator: captured } : {};
}

export function createRestartRecoveryRequesterSource(params: {
  requesterOrigin?: RequesterOrigin;
  entry: InternalSessionEntry;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
  /** FORK: the linked channel authority admitting this exact requester turn. */
  channelOperatorAuthority?: AdmittedRunOperatorAuthority;
}): RestartRecoveryRequesterSource | undefined {
  const requesterOrigin = params.requesterOrigin && captureRequesterOrigin(params);
  if (
    !requesterOrigin ||
    !resolveRequesterPrincipalKey({ requesterOrigin }) ||
    params.entry.incognito
  ) {
    return undefined;
  }
  const source = {
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.entry.sessionId,
    lifecycleRevision: params.entry.lifecycleRevision,
    sourceRunId: params.sourceRunId,
    requesterOrigin,
    ...captureChannelOperatorBasis(params.channelOperatorAuthority, requesterOrigin),
  };
  return Buffer.byteLength(JSON.stringify(source), "utf8") <= 65_536
    ? Object.freeze(source)
    : undefined;
}

type RequesterSourceClaim = {
  entry: InternalSessionEntry;
  agentId: string;
  sessionKey: string;
  sourceRunId: string;
};

function readCurrentRequesterSource(
  params: RequesterSourceClaim,
): RestartRecoveryRequesterSource | undefined {
  const source = params.entry.restartRecoveryRequesterSource;
  if (
    !source ||
    source.agentId !== params.agentId ||
    source.sessionKey !== params.sessionKey ||
    source.sessionId !== params.entry.sessionId ||
    source.lifecycleRevision !== params.entry.lifecycleRevision ||
    source.sourceRunId !== params.sourceRunId
  ) {
    return undefined;
  }
  return source;
}

/** Only a private current session claim supplies this source; transcript copies cannot. */
export function readRestartRecoveryRequesterSource(
  params: RequesterSourceClaim,
): RequesterOrigin | undefined {
  const source = readCurrentRequesterSource(params);
  if (!source) {
    return undefined;
  }
  const requesterOrigin = decodeRequesterOrigin(source.requesterOrigin);
  return requesterOrigin && resolveRequesterPrincipalKey({ requesterOrigin })
    ? requesterOrigin
    : undefined;
}

/** FORK: the undecoded channel operator basis bound to the same exact current claim. */
export function readRestartRecoveryChannelOperatorSource(
  params: RequesterSourceClaim,
): { profileId: string; source: unknown } | undefined {
  const source = readCurrentRequesterSource(params);
  const profileId = source?.requesterOrigin.operatorProfileId;
  return source?.channelOperator !== undefined && profileId
    ? { profileId, source: source.channelOperator }
    : undefined;
}

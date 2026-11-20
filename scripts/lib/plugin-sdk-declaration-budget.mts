// Raised for OpenClaw ID membership, connected-app ingress principals, and decision/model
// catalog contracts (2026-11-09..13: 5,249,082 -> 5,315,563 bytes across ~1,500 commits);
// the cap exists to force a conscious decision on published declaration growth.
// FORK(sdk-budget): +16 KB headroom for fork plugin-sdk surface (createLazyFacadeValue etc.);
// we never publish SDK artifacts, so the cap only needs to keep local builds from aborting.
export const MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES = 5_336_000;
// Rolldown can repartition equivalent declaration chunks between clean builds; measured spread is
// about 29 KiB across hosts. Keep one 64 KiB scheduling window above the intentional size ratchet.
export const PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES = 64 * 1024;

export function isPrivateQaPluginSdkBuild(env: NodeJS.ProcessEnv): boolean {
  return env.OPENCLAW_BUILD_PRIVATE_QA === "1";
}

export function evaluatePluginSdkDeclarationBudget({
  declarationBytes,
}: {
  declarationBytes: number;
}) {
  const ratchetBytes = MAX_PUBLIC_PLUGIN_SDK_DECLARATION_BYTES;
  const budgetBytes = ratchetBytes + PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES;
  return {
    budgetBytes,
    ratchetBytes,
    shouldFail: declarationBytes > budgetBytes,
    varianceBytes: PLUGIN_SDK_DECLARATION_OUTPUT_VARIANCE_BYTES,
  };
}

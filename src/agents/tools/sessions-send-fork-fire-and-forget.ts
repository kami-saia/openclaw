// FORK(fire-and-forget): disables the A2A ping-pong/announce-back flow.
// Named binding rather than an inline `true ||` so the override is greppable
// and survives upstream merges. See fork commit 9717e7c9c8a. Upstream's reply
// flow stays reachable (and covered) via the test-only override below.
let forkFireAndForget = true;

export function isForkFireAndForget(): boolean {
  return forkFireAndForget;
}

/** Test-only switch for exercising upstream's A2A announce flow. */
export const forkFireAndForgetTesting = {
  setForTest(value: boolean): void {
    forkFireAndForget = value;
  },
  reset(): void {
    forkFireAndForget = true;
  },
};

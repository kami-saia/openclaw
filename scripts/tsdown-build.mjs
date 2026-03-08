#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const packageManager = process.env.npm_execpath ?? "pnpm";
const packageManagerArgs = ["exec", "tsdown", "--", "--config-loader", "unrun", "--logLevel", logLevel];
const shouldRunViaNode = process.platform === "win32" && /\.(?:c?m?js)$/i.test(packageManager);
const result = spawnSync(
  shouldRunViaNode ? process.execPath : packageManager,
  shouldRunViaNode ? [packageManager, ...packageManagerArgs] : packageManagerArgs,
  {
    stdio: "inherit",
    shell: !shouldRunViaNode && process.platform === "win32",
  },
);

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);

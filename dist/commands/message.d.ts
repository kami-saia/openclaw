import { type CliDeps } from "../cli/outbound-send-deps.js";
import type { RuntimeEnv } from "../runtime.js";
export declare function messageCommand(opts: Record<string, unknown>, deps: CliDeps, runtime: RuntimeEnv): Promise<void>;

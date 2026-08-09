import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { parseForkGuardConfig } from "./src/config.js";
import { analyzeExecToolCall } from "./src/guard.js";

export function registerForkGuardPlugin(api: OpenClawPluginApi): void {
  const config = parseForkGuardConfig(api.pluginConfig);
  if (!config.enabled) {
    api.logger.info("fork-guard disabled");
    return;
  }

  // FORK: upstream replaced the untyped `toolNames` scoping option with a typed
  // `matcher` on PluginHookRegistrationOptions, so the ToolScopedOn cast that
  // used to be needed here is gone and `api.on` is used directly.
  api.on(
    "before_tool_call",
    async (event, ctx) => {
      const result = await analyzeExecToolCall({
        event,
        ctx,
        config,
        logger: api.logger,
      });
      return result;
    },
    { matcher: ["exec"] },
  );
}

export default definePluginEntry({
  id: "fork-guard",
  name: "Fork Guard",
  description: "Blocks git push / gh pr create when the outgoing diff contains private content.",
  register: registerForkGuardPlugin,
});

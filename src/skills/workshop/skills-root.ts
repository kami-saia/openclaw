import path from "node:path";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveUserPath } from "../../infra/home-dir.js";

export function resolveWorkshopSkillsDir(
  config: OpenClawConfig,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Fork-only override: keep the applied Workshop collection on a git-tracked
  // path. Every caller (loader, watcher, store, apply, doctor relocation,
  // audit, cron) funnels through here, so the override also stops doctor from
  // classifying the configured location as a legacy dir needing relocation.
  const configured = config.skills?.workshop?.skillsDir?.trim();
  if (configured) {
    return resolveUserPath(configured, env);
  }
  return path.join(resolveAgentDir(config, agentId, env), "workshop-skills");
}

export function resolveWorkshopWatchRoots(config?: OpenClawConfig, agentId?: string) {
  return config && agentId
    ? [{ path: resolveWorkshopSkillsDir(config, agentId), source: "openclaw-workshop" }]
    : [];
}

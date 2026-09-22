import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";

const CONTEXT_FILE_ORDER = new Map<string, number>([
  ["agents.md", 10],
  ["soul.md", 20],
  ["identity.md", 30],
  ["user.md", 40],
  ["tools.md", 50],
  ["bootstrap.md", 60],
  ["memory.md", 70],
]);

const DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK =
  /Default heartbeat prompt:\r?\n`(?:Read HEARTBEAT\.md if it exists|Follow the heartbeat monitor scratch context when provided\.)[^`\r\n]*HEARTBEAT_OK\.`/gu;
function normalizeContextFilePath(pathValue: string): string {
  return pathValue.trim().replace(/\\/g, "/");
}

export function isBootstrapContextFile(pathValue: string): boolean {
  return /(^|[\\/])BOOTSTRAP\.md$/iu.test(pathValue.trim());
}

export function sanitizeContextFileContentForPrompt(content: string): string {
  // Old workspace templates otherwise route Claude subscriptions to paid extra
  // usage; heartbeat behavior remains in the actual scheduled user turn.
  return content.replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\n{3,}/g, "\n\n");
}

export function prepareContextFilesForPrompt(contextFiles: EmbeddedContextFile[]) {
  return contextFiles
    .map((file) => {
      const path = normalizeContextFilePath(file.path);
      const basename = normalizeLowercaseStringOrEmpty(path.slice(path.lastIndexOf("/") + 1));
      return {
        file,
        path,
        basename,
        order: CONTEXT_FILE_ORDER.get(basename) ?? Number.MAX_SAFE_INTEGER,
      };
    })
    .toSorted((a, b) => {
      if (a.order !== b.order) {
        return a.order - b.order;
      }
      if (a.basename !== b.basename) {
        return a.basename.localeCompare(b.basename);
      }
      // Preserve loader precedence for shared USER defaults and the personal overlay.
      return a.basename === "user.md" ? 0 : a.path.localeCompare(b.path);
    });
}

// FORK: soul files are emitted by buildSoulSection (system-prompt.ts) as a
// constitutive "# Identity" section hoisted above tool guidance, so they are
// excluded here and never get upstream's "SOUL.md: persona/tone" bullet, which
// reframes the identity file as mere reference material.
export function buildProjectContextSection(files: ReturnType<typeof prepareContextFilesForPrompt>) {
  const contextFiles = files.filter(({ basename }) => basename !== "soul.md");
  if (contextFiles.length === 0) {
    return [];
  }
  const lines = ["# Project Context", ""];
  const hasMemoryFile = contextFiles.some((file) => file.basename === "memory.md");
  const hasUserFile = contextFiles.some((file) => file.basename === "user.md");
  lines.push("Loaded project context:");
  if (hasMemoryFile) {
    lines.push(
      "MEMORY.md: durable non-profile facts and decisions; use when relevant unless higher-priority instructions override.",
    );
  }
  if (hasUserFile) {
    lines.push(
      "USER.md: durable user preferences and profile directives; follow unless higher-priority instructions override.",
    );
  }
  if (contextFiles.some(({ file }) => file.personalUser)) {
    lines.push(
      "The personal users/<profile-id>/USER.md belongs to this session's selected person (assigned human owner, otherwise human creator). It supplements shared USER.md and overrides conflicting shared preferences, not higher-priority rules. Other participants do not change this personal context.",
    );
  }
  lines.push("");
  for (const { file } of contextFiles) {
    lines.push(`## ${file.path}`, "", sanitizeContextFileContentForPrompt(file.content), "");
  }
  return lines;
}

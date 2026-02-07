import type { FileDiff } from "./types";

/**
 * Convert FileDiff to unified diff format
 */
export function toUnifiedDiff(diff: FileDiff): string {
  const beforeLines = diff.before.split("\n");
  const afterLines = diff.after.split("\n");

  let result = `--- a/${diff.file}\n+++ b/${diff.file}\n`;

  // Simple unified diff - show all as changed
  if (beforeLines.length > 0 || afterLines.length > 0) {
    result += `@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;
    for (const line of beforeLines) {
      if (line || beforeLines.length === 1) {
        result += `-${line}\n`;
      }
    }
    for (const line of afterLines) {
      if (line || afterLines.length === 1) {
        result += `+${line}\n`;
      }
    }
  }

  return result;
}

/**
 * Get file extension for syntax highlighting
 */
export function getFiletype(filename: string): string | undefined {
  const ext = filename.split(".").pop()?.toLowerCase();
  const mapping: Record<string, string> = {
    py: "python",
    js: "javascript",
    ts: "typescript",
    tsx: "tsx",
    jsx: "jsx",
    md: "markdown",
    json: "json",
    toml: "toml",
    yaml: "yaml",
    yml: "yaml",
  };
  return ext ? mapping[ext] : undefined;
}

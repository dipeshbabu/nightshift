export interface FileDiff {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

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

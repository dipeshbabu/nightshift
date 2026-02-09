import type { RalphEvent } from "../../cli/agents/events";

/**
 * Format a RalphEvent into a display string.
 * Returns null for text deltas (handled separately by the TUI for streaming).
 */
export function formatEvent(event: RalphEvent): string | null {
  switch (event.type) {
    case "ralph.started":
      return `[ralph] Workspace: ${event.workspace}\n[ralph] Starting worker and boss servers...`;
    case "ralph.completed":
      return `[ralph] Completed after ${event.iterations} iteration(s). Done: ${event.done}`;
    case "ralph.error":
      return `[ralph] Error: ${event.error}`;
    case "ralph.interrupted":
      return `[ralph] Run interrupted (${event.reason})`;
    case "server.ready":
      return event.reused
        ? `[ralph] Reusing existing ${event.name} server (port ${event.port})`
        : `[ralph] Started ${event.name} server (port ${event.port})`;
    case "server.cleanup":
      return `[ralph] Cleaning up stale ${event.name} process (pid ${event.pid})`;
    case "loop.iteration.start":
      return `\n── Iteration ${event.iteration} ──`;
    case "loop.done":
      return `[ralph] Boss says DONE. Exiting.`;
    case "loop.not_done":
      return `[ralph] Not done yet. Looping...`;
    case "loop.max_iterations":
      return `[ralph] Reached max iterations (${event.maxIterations}). Exiting.`;
    case "worker.start":
      return `\n── Worker run on ${event.commitHash} ──`;
    case "worker.complete":
      return event.logPath ? `\n[ralph] Worker log: ${event.logPath}` : null;
    case "boss.start":
      return `── Boss on ${event.commitHash} ──`;
    case "boss.complete":
      return event.logPath ? `\n[ralph] Boss log: ${event.logPath}` : null;
    case "session.text.delta":
      return null;
    case "session.tool.status": {
      const { tool, status, detail, input, output, duration } = event;
      const title = detail || tool;
      if (status === "running") {
        let msg = `\n▶ ${title}`;
        if (input) msg += ` ${JSON.stringify(input)}`;
        return msg;
      }
      if (status === "completed") {
        let msg = `✓ ${title}`;
        if (duration !== undefined) msg += ` (${duration.toFixed(1)}s)`;
        if (output) msg += `\n${output}`;
        return msg;
      }
      if (status === "error") {
        let msg = `✗ ${title}: ${detail}`;
        if (input) msg += `\n  input: ${JSON.stringify(input)}`;
        if (duration !== undefined) msg += `\n  duration: ${duration.toFixed(1)}s`;
        return msg;
      }
      return null;
    }
    case "session.permission":
      return `[Auto-approving ${event.permission}${event.description ? `: ${event.description}` : ""}]`;
    case "worktree.created":
      return `[ralph] Created worktree: ${event.branchName} → ${event.worktreePath}`;
    case "worktree.merged":
      return `[ralph] Merged ${event.branchName} into main`;
    case "worktree.merge_conflict":
      return `[ralph] Merge conflict on ${event.branchName}:\n${event.conflicts}`;
    case "worktree.removed":
      return `[ralph] Removed worktree: ${event.branchName}`;
    default:
      return null;
  }
}

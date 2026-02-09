/**
 * Standalone daemon entry point for the ralph HTTP server.
 * Spawned as a detached child process so the TUI can exit independently.
 *
 * Usage: bun run src/cli/agents/ralph-serve-entry.ts --prefix <p> --port <n> --workspace <w> --agent-model <m> --eval-model <m>
 */
import { join } from "path";
import { mkdirSync } from "fs";
import { createBus, taggedPublisher } from "./bus";
import { startRalphServer } from "./ralph-server";
import { startAgentServer } from "./server";
import { runAgentLoop } from "./loop";
import {
  createWorktree,
  mergeMainIntoWorktree,
  mergeWorktreeIntoMain,
  removeWorktree,
  abortMerge,
  withMergeLock,
  pruneStaleWorktrees,
} from "./worktree";
import { resolve as resolveConflicts } from "./resolver";

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
  };
  return {
    prefix: get("--prefix")!,
    port: Number(get("--port") ?? 3000),
    workspace: get("--workspace")!,
    agentModel: get("--agent-model") ?? "openai/gpt-5.2-codex",
    evalModel: get("--eval-model") ?? "openai/gpt-5.2-codex",
  };
}

const args = parseArgs(process.argv);
if (!args.prefix || !args.workspace) {
  console.error("Usage: --prefix <path> --workspace <path> [--port N] [--agent-model M] [--eval-model M]");
  process.exit(1);
}

const { prefix, port, workspace, agentModel, evalModel } = args;
const logDir = join(prefix, "agent_logs");
const worktreesDir = join(prefix, "worktrees");
mkdirSync(logDir, { recursive: true });
mkdirSync(worktreesDir, { recursive: true });

const bus = createBus();

// Track active agent server handles so we can kill them on shutdown
const activeHandles = new Set<{ kill: () => void }>();

process.on("exit", () => {
  for (const handle of activeHandles) {
    try { handle.kill(); } catch {}
  }
});

// Prune stale worktrees left behind by a previous crash
await pruneStaleWorktrees(workspace, worktreesDir);

startRalphServer({
  port,
  bus,
  prefix,
  onPrompt: async (prompt: string, runId: string) => {
    const publisher = taggedPublisher(bus, runId);
    const shortId = runId.slice(0, 16);
    const branchName = `task/${shortId}`;

    // Create an isolated worktree for this task
    const worktreePath = await createWorktree({
      repoPath: workspace,
      worktreesDir,
      branchName,
    });

    publisher.publish({
      type: "worktree.created",
      timestamp: Date.now(),
      branchName,
      worktreePath,
    });

    // Start fresh agent servers scoped to the worktree
    const [bossHandle, workerHandle] = await Promise.all([
      startAgentServer({ prefix, workspace: worktreePath, name: `nightshift-boss-${shortId}`, bus: publisher }),
      startAgentServer({ prefix, workspace: worktreePath, name: `nightshift-worker-${shortId}`, bus: publisher }),
    ]);

    activeHandles.add(bossHandle);
    activeHandles.add(workerHandle);

    try {
      const result = await runAgentLoop({
        workerClient: workerHandle.client,
        bossClient: bossHandle.client,
        workspace: worktreePath,
        prompt,
        agentModel,
        evalModel,
        logDir,
        bus: publisher,
      });

      if (result.done) {
        // Integrate task branch with main
        let merge = await mergeMainIntoWorktree(worktreePath);
        let retries = 0;

        while (!merge.clean && retries < 3) {
          publisher.publish({
            type: "worktree.merge_conflict",
            timestamp: Date.now(),
            branchName,
            conflicts: merge.conflicts ?? "",
          });

          await resolveConflicts({
            client: workerHandle.client,
            worktreePath,
            conflicts: merge.conflicts ?? "",
            model: agentModel,
            bus: publisher,
          });

          // Abort any leftover merge state before retrying
          await abortMerge(worktreePath);
          merge = await mergeMainIntoWorktree(worktreePath);
          retries++;
        }

        if (merge.clean) {
          await withMergeLock(async () => {
            await mergeWorktreeIntoMain(workspace, branchName);
          });
          publisher.publish({
            type: "worktree.merged",
            timestamp: Date.now(),
            branchName,
          });
        } else {
          publisher.publish({
            type: "ralph.error",
            timestamp: Date.now(),
            error: `Could not resolve merge conflicts after ${retries} retries`,
          });
        }
      }

      publisher.publish({
        type: "ralph.completed",
        timestamp: Date.now(),
        iterations: result.iterations,
        done: result.done,
      });
    } finally {
      activeHandles.delete(bossHandle);
      activeHandles.delete(workerHandle);
      bossHandle.kill();
      workerHandle.kill();
      await removeWorktree({ repoPath: workspace, worktreePath, branchName });
      publisher.publish({
        type: "worktree.removed",
        timestamp: Date.now(),
        branchName,
      });
    }
  },
});

// Graceful shutdown on SIGTERM
process.on("SIGTERM", () => {
  process.exit(0);
});

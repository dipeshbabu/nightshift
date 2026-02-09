import { resolve, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { checkSandboxAvailability } from "../../lib/platform";
import { readFullConfig, expandHome } from "../../lib/config";
import { buildXdgEnv, buildUvEnv } from "../../lib/env";
import { buildSandboxCommand, type SandboxOptions } from "../../lib/sandbox";
import { startAgentServer } from "../agents/server";
import { runAgentLoop } from "../agents/loop";
import { createBus, taggedPublisher } from "../agents/bus";
import { createWorktree, mergeMainIntoWorktree, mergeWorktreeIntoMain, removeWorktree } from "../agents/worktree";
import { resolve as resolveConflicts } from "../agents/resolver";
import type { RalphEvent } from "../agents/events";

export function extractExtraArgs(argv: string[]): string[] {
  const dashIdx = argv.indexOf("--");
  return dashIdx >= 0 ? argv.slice(dashIdx + 1) : [];
}

interface RunOptions {
  extra: string[]
  useNightshiftTui: boolean
  sandboxEnabled: boolean
  skipAgentBoot: boolean
  ralphEnabled: boolean
  ralphPrompt?: string
  ralphAgentModel: string
  ralphEvalModel: string
}

export function resolveRunOptions(
  argv: { [key: string]: unknown },
  processArgv: string[],
): RunOptions {
  return {
    extra: extractExtraArgs(processArgv),
    useNightshiftTui: Boolean(argv["run-nightshift-tui"]),
    sandboxEnabled: Boolean(argv["sandbox"]),
    skipAgentBoot: Boolean(argv["skip-ai-boot"]),
    ralphEnabled: Boolean(argv["ralph"]),
    ralphPrompt: argv["prompt"] as string | undefined,
    ralphAgentModel: (argv["agent-model"] as string) || "openai/gpt-5.2-codex",
    ralphEvalModel: (argv["eval-model"] as string) || "openai/gpt-5.2-codex",
  };
}

export function buildAttachTuiArgs(url: string, session: string | undefined, directory: string): {
  url: string;
  args: { sessionID?: string };
  directory: string;
} {
  return {
    url,
    args: session ? { sessionID: session } : {},
    directory,
  };
}

export interface RalphOptions {
  enabled: boolean;
  prompt?: string;
  agentModel: string;
  evalModel: string;
  useNightshiftTui: boolean;
  serve?: boolean;
  servePort?: number;
}

export async function run(prefix: string, args: string[], useNightshiftTui: boolean, sandboxEnabled: boolean, ralphOptions?: RalphOptions): Promise<void> {
  prefix = resolve(prefix);
  const binDir = join(prefix, "bin");
  const uvToolsBin = join(prefix, "uv-tools", "bin");
  const opencode = join(binDir, "opencode");

  if (!existsSync(opencode)) {
    throw new Error(`opencode not found at ${opencode}. Run install first.`);
  }

  // Check sandbox availability if requested
  if (sandboxEnabled) {
    const sandboxCheck = await checkSandboxAvailability();
    if (!sandboxCheck.available) {
      throw new Error(`Sandbox requested but not available: ${sandboxCheck.reason}`);
    }
    console.log("Sandbox mode enabled");
  }

  // Compute workspace paths
  const config = await readFullConfig(process.cwd());
  const workspacePath = config?.workspacePath
    ? resolve(expandHome(config.workspacePath))
    : join(prefix, "workspace");
  const workspaceVenvBin = join(workspacePath, ".venv", "bin");

  // Build PATH with workspace venv and uv tools if they exist
  let pathParts = [binDir];
  if (existsSync(workspaceVenvBin)) pathParts.unshift(workspaceVenvBin);
  if (existsSync(uvToolsBin)) pathParts.unshift(uvToolsBin);
  const PATH = `${pathParts.join(":")}:${process.env.PATH ?? ""}`;

  const xdgEnv = buildXdgEnv(prefix);
  const uvEnv = buildUvEnv(prefix);

  // Build sandbox options
  const sandboxOpts: SandboxOptions = {
    workspacePath,
    prefixPath: prefix,
    binDir,
    env: {
      ...xdgEnv,
      ...uvEnv,
      PATH,
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
      TERM: process.env.TERM ?? "xterm-256color",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      OPENCODE_EXPERIMENTAL_LSP_TY: "true",
    },
  };

  if (ralphOptions?.enabled) {
    await runWithRalph(prefix, workspacePath, ralphOptions);
    return;
  }

  if (useNightshiftTui) {
    // Start opencode as a server and attach nightshift TUI
    await runWithNightshiftTui(opencode, PATH, workspacePath, args, xdgEnv, sandboxEnabled, sandboxOpts);
  } else {
    // Standard opencode execution
    console.log(`Launching opencode with isolated PATH`);
    console.log(`  PATH prefix: ${pathParts.join(":")}`);

    const baseCommand = [opencode, ...args];
    const finalCommand = sandboxEnabled
      ? buildSandboxCommand(baseCommand, sandboxOpts)
      : baseCommand;

    const proc = Bun.spawn(finalCommand, {
      cwd: workspacePath,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: sandboxEnabled ? sandboxOpts.env : {
        ...process.env,
        ...xdgEnv,
        ...uvEnv,
        PATH,
        OPENCODE_EXPERIMENTAL_LSP_TY: "true",
      },
    });

    const exitCode = await proc.exited;
    process.exit(exitCode);
  }
}

function formatEventForCli(event: RalphEvent): string | null {
  switch (event.type) {
    case "ralph.started":
      return `[ralph] Workspace: ${event.workspace}\n[ralph] Starting executor and validator servers...`;
    case "ralph.completed":
      return `[ralph] Completed after ${event.iterations} iteration(s). Done: ${event.done}`;
    case "ralph.error":
      return `[ralph] Error: ${event.error}`;
    case "server.ready":
      return event.reused
        ? `[ralph] Reusing existing ${event.name} server (port ${event.port})`
        : `[ralph] Started ${event.name} server (port ${event.port})`;
    case "server.cleanup":
      return `[ralph] Cleaning up stale ${event.name} process (pid ${event.pid})`;
    case "loop.iteration.start":
      return `\n[ralph] ── Iteration ${event.iteration} ──`;
    case "loop.done":
      return `[ralph] Boss says DONE. Exiting.`;
    case "loop.not_done":
      return `[ralph] Not done yet. Looping...`;
    case "loop.max_iterations":
      return `[ralph] Reached max iterations (${event.maxIterations}). Exiting.`;
    case "worker.start":
      return `\n[ralph] ── Worker run on ${event.commitHash} ──`;
    case "worker.complete":
      return event.logPath ? `\n[ralph] Worker log: ${event.logPath}` : null;
    case "boss.start":
      return `[ralph] ── Boss on ${event.commitHash} ──`;
    case "boss.complete":
      return event.logPath ? `\n[ralph] Boss log: ${event.logPath}` : null;
    case "session.text.delta":
      process.stdout.write(event.delta);
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
    case "resolver.start":
      return `\n[ralph] ── Resolver resolving conflicts ──\n${event.conflicts}`;
    case "resolver.complete":
      return `[ralph] ── Resolver finished ──`;
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

async function runWithRalph(prefix: string, workspacePath: string, options: RalphOptions): Promise<void> {
  const { agentModel, evalModel } = options;
  const logDir = join(prefix, "agent_logs");
  mkdirSync(logDir, { recursive: true });

  const bus = createBus();

  // Serve mode: start HTTP server, prompt comes from POST requests
  if (options.serve) {
    const { startRalphServer } = await import("../agents/ralph-server");
    const port = options.servePort ?? 3000;

    const worktreesDir = join(prefix, "worktrees");
    mkdirSync(worktreesDir, { recursive: true });

    startRalphServer({
      port,
      bus,
      prefix,
      onPrompt: async (prompt: string, runId: string) => {
        const publisher = taggedPublisher(bus, runId);
        const shortId = runId.slice(0, 8);
        const branchName = `task/${shortId}`;

        // Create an isolated worktree for this task
        const worktreePath = await createWorktree({
          repoPath: workspacePath,
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

              merge = await mergeMainIntoWorktree(worktreePath);
              retries++;
            }

            if (merge.clean) {
              await mergeWorktreeIntoMain(workspacePath, branchName);
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
          bossHandle.kill();
          workerHandle.kill();
          await removeWorktree({ repoPath: workspacePath, worktreePath, branchName });
          publisher.publish({
            type: "worktree.removed",
            timestamp: Date.now(),
            branchName,
          });
        }
      },
    });

    if (options.useNightshiftTui) {
      const { ralphTui } = await import("../../tui/ralph/index");
      await ralphTui({ serverUrl: `http://localhost:${port}` });
    } else {
      // Keep process alive
      await new Promise(() => { });
    }
    return;
  }

  // CLI mode: subscribe to bus and format events to console
  const runId = crypto.randomUUID();
  const publisher = taggedPublisher(bus, runId);

  bus.subscribeAll((event) => {
    const line = formatEventForCli(event);
    if (line !== null) console.log(line);
  });

  publisher.publish({
    type: "ralph.started",
    timestamp: Date.now(),
    workspace: workspacePath,
    agentModel,
    evalModel,
  });

  // handles to both the worker and the boss agents
  const [bossHandle, workerHandle] = await Promise.all([
    startAgentServer({ prefix, workspace: workspacePath, name: "nightshift-boss", bus: publisher }),
    startAgentServer({ prefix, workspace: workspacePath, name: "nightshift-worker", bus: publisher }),
  ]);
  const killAll = () => {
    bossHandle.kill();
    workerHandle.kill();
  };

  // you can programatically interact with the agent server by passing in a prompt
  if (!options.prompt) {
    throw new Error("[ralph] --prompt <file> is required");
  }
  const promptFile = Bun.file(options.prompt);
  if (!(await promptFile.exists())) {
    throw new Error(`[ralph] Prompt file not found: ${options.prompt}`);
  }
  const prompt = await promptFile.text();

  // this is the main agent loop for the ralph worker/boss setup
  try {
    const result = await runAgentLoop({
      workerClient: workerHandle.client,
      bossClient: bossHandle.client,
      workspace: workspacePath,
      prompt,
      agentModel,
      evalModel,
      logDir,
      bus: publisher,
    });

    publisher.publish({
      type: "ralph.completed",
      timestamp: Date.now(),
      iterations: result.iterations,
      done: result.done,
    });
  } finally {
    killAll();
  }

  process.exit(0);
}

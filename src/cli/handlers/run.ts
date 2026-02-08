import { resolve, join } from "path";
import { mkdirSync, existsSync } from "fs";
import { checkSandboxAvailability } from "../../lib/platform";
import { readFullConfig, expandHome } from "../../lib/config";
import { buildXdgEnv, buildUvEnv } from "../../lib/env";
import { buildSandboxCommand, type SandboxOptions } from "../../lib/sandbox";
import { startAgentServer } from "../agents/server";
import { runAgentLoop } from "../agents/loop";

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

async function runWithNightshiftTui(opencodePath: string, PATH: string, workspacePath: string, _args: string[], xdgEnv: Record<string, string>, sandboxEnabled: boolean, sandboxOpts: SandboxOptions): Promise<void> {
  // Find an available port
  const port = 4096 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;

  console.log(`Starting opencode server on port ${port}...`);

  // Build server command
  const baseServerCommand = [opencodePath, "serve", "--hostname", "0.0.0.0", "--port", String(port)];
  const finalServerCommand = sandboxEnabled
    ? buildSandboxCommand(baseServerCommand, sandboxOpts)
    : baseServerCommand;

  // Start opencode as a server
  const serverProc = Bun.spawn(finalServerCommand, {
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
    env: sandboxEnabled ? sandboxOpts.env : {
      ...process.env,
      ...xdgEnv,
      ...buildUvEnv(sandboxOpts.prefixPath),
      PATH,
      OPENCODE_EXPERIMENTAL_LSP_TY: "true",
    },
  });

  // Wait for server to be ready
  let ready = false;
  const maxAttempts = 30;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/global/health`);
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!ready) {
    serverProc.kill();
    throw new Error("Failed to start opencode server");
  }

  console.log(`Server ready. Launching Nightshift TUI...`);

  // Import and launch the nightshift TUI
  const { tui } = await import("../../tui/tui/app");

  try {
    await tui({ url, args: {}, directory: workspacePath });
  } finally {
    // Clean up server when TUI exits
    serverProc.kill();
  }
}

async function runWithRalph(prefix: string, workspacePath: string, options: RalphOptions): Promise<void> {
  const { agentModel, evalModel, useNightshiftTui } = options;
  const logDir = join(prefix, "agent_logs");
  mkdirSync(logDir, { recursive: true });

  console.log(`[ralph] Workspace: ${workspacePath}`);
  console.log("[ralph] Starting executor and validator servers...");

  const [executorHandle, validatorHandle] = await Promise.all([
    startAgentServer({ prefix, workspace: workspacePath, name: "nightshift-executor" }),
    startAgentServer({ prefix, workspace: workspacePath, name: "nightshift-validator" }),
  ]);

  const killAll = () => {
    executorHandle.kill();
    validatorHandle.kill();
  };

  // Auth is handled by each opencode server via auth.json in XDG_DATA_HOME

  let prompt: string;

  if (useNightshiftTui) {
    // Start TUI and wait for prompt from user — connects to executor server
    const { tui } = await import("../../tui/tui/app");
    const promptPromise = new Promise<string>((resolve) => {
      // The TUI will call this when the user submits a prompt in ralph mode
      (globalThis as any).__ralphPromptResolve = resolve;
    });

    // Launch TUI in the background — it renders to the terminal
    const tuiPromise = tui({ url: executorHandle.serverUrl, args: { ralph: true }, directory: workspacePath });

    console.log("[ralph] Waiting for prompt from TUI...");
    prompt = await promptPromise;

    // Run the loop (TUI stays active showing executor sessions)
    try {
      await runAgentLoop({
        executorClient: executorHandle.client,
        validatorClient: validatorHandle.client,
        workspace: workspacePath,
        prompt,
        agentModel,
        evalModel,
        logDir,
      });
    } finally {
      killAll();
    }

    // Wait for TUI to exit
    await tuiPromise;
  } else {
    // Headless mode: read prompt from file
    if (!options.prompt) {
      throw new Error("[ralph] --prompt <file> is required when not using TUI");
    }

    const promptFile = Bun.file(options.prompt);
    if (!(await promptFile.exists())) {
      throw new Error(`[ralph] Prompt file not found: ${options.prompt}`);
    }
    prompt = await promptFile.text();

    try {
      await runAgentLoop({
        executorClient: executorHandle.client,
        validatorClient: validatorHandle.client,
        workspace: workspacePath,
        prompt,
        agentModel,
        evalModel,
        logDir,
      });
    } finally {
      killAll();
    }

    process.exit(0);
  }
}

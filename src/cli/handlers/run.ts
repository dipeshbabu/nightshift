import { resolve, join } from "path";
import { existsSync } from "fs";
import { checkSandboxAvailability } from "../../lib/platform";
import { readFullConfig, expandHome } from "../../lib/config";
import { buildXdgEnv, buildUvEnv } from "../../lib/env";
import { buildSandboxCommand, type SandboxOptions } from "../../lib/sandbox";

export function extractExtraArgs(argv: string[]): string[] {
  const dashIdx = argv.indexOf("--");
  return dashIdx >= 0 ? argv.slice(dashIdx + 1) : [];
}

export function resolveRunOptions(
  argv: { [key: string]: unknown },
  processArgv: string[],
): { extra: string[]; useNightshiftTui: boolean; sandboxEnabled: boolean } {
  return {
    extra: extractExtraArgs(processArgv),
    useNightshiftTui: Boolean(argv["run-nightshift-tui"]),
    sandboxEnabled: Boolean(argv["sandbox"]),
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

export async function run(prefix: string, args: string[], useNightshiftTui: boolean, sandboxEnabled: boolean): Promise<void> {
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

import yargs from "yargs";
import { resolve, join, relative } from "path";
import { homedir } from "os";
import { mkdirSync, symlinkSync, existsSync, chmodSync } from "fs";
import { buildSandboxCommand, type SandboxOptions } from "./sandbox";
const { runBootstrapPrompt } = await import("./bootstrap-prompt");
const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");


const OPENCODE_VERSION = "v1.1.37"
const PYTHON_VERSION = "3.13.11";
const PYTHON_RELEASE = "20260127";
const UV_VERSION = "0.9.27";
const RIPGREP_VERSION = "15.1.0";

const WORKSPACE_PACKAGES = ["numpy", "pandas", "matplotlib", "scikit-learn", "jupyter"];

interface Platform {
  os: "darwin" | "linux";
  arch: "x86_64" | "aarch64";
}

interface NightshiftConfig {
  activePrefix?: string;
  prefix?: string;
  workspacePath?: string;
  libraryName?: string;
  workspacePackages?: string[];
}

function detectPlatform(): Platform {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return { os, arch };
}

function configSearchPaths(cwd: string): string[] {
  const paths = [join(cwd, "nightshift.json")];
  // Use process.env.HOME first (allows testing), fallback to homedir()
  const home = process.env.HOME || homedir();
  if (home) {
    paths.push(join(home, ".config", "nightshift", "nightshift.json"));
  }
  return paths;
}

function expandHome(input: string): string {
  if (!input.startsWith("~")) return input;
  const home = homedir();
  if (!home) return input;
  if (input === "~") return home;
  if (input.startsWith("~/")) return join(home, input.slice(2));
  return input;
}

async function readConfigFile(path: string): Promise<NightshiftConfig | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  const text = await file.text();
  try {
    return JSON.parse(text) as NightshiftConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse nightshift.json at ${path}: ${message}`);
  }
}

async function resolvePrefixFromConfig(cwd: string): Promise<{ prefix: string; source: string }> {
  for (const configPath of configSearchPaths(cwd)) {
    const config = await readConfigFile(configPath);
    if (!config) continue;
    const prefix = config.activePrefix ?? config.prefix;
    if (!prefix) {
      throw new Error(
        `nightshift.json at ${configPath} must include "activePrefix" (or "prefix").`,
      );
    }
    return { prefix: expandHome(prefix), source: configPath };
  }

  const locations = configSearchPaths(cwd).join(", ");
  throw new Error(`No nightshift.json found. Looked in: ${locations}`);
}

async function readFullConfig(cwd: string): Promise<NightshiftConfig | null> {
  for (const configPath of configSearchPaths(cwd)) {
    const config = await readConfigFile(configPath);
    if (config) return config;
  }
  return null;
}

async function saveActivePrefix(prefix: string): Promise<void> {
  // Use process.env.HOME first (allows testing), fallback to homedir()
  const home = process.env.HOME || homedir();
  if (!home) return;

  // Check for local config first - if it exists, update it (since it takes precedence)
  const localConfigPath = join(process.cwd(), "nightshift.json");
  const localFile = Bun.file(localConfigPath);
  if (await localFile.exists()) {
    let localConfig: NightshiftConfig = {};
    try {
      localConfig = JSON.parse(await localFile.text());
    } catch {
      // Ignore parse errors, start fresh
    }
    localConfig.activePrefix = prefix;
    await Bun.write(localConfigPath, JSON.stringify(localConfig, null, 2));
    console.log(`  Saved active prefix to ${localConfigPath}`);
    return;
  }

  // No local config, save to global config
  const configDir = join(home, ".config", "nightshift");
  const configPath = join(configDir, "nightshift.json");

  mkdirSync(configDir, { recursive: true });

  // Read existing config to preserve other fields
  let config: NightshiftConfig = {};
  const file = Bun.file(configPath);
  if (await file.exists()) {
    try {
      config = JSON.parse(await file.text());
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  config.activePrefix = prefix;
  await Bun.write(configPath, JSON.stringify(config, null, 2));
  console.log(`  Saved active prefix to ${configPath}`);
}


function opencodeUrl(p: Platform): { url: string; extractedBinary: string } {
  const os = p.os === "darwin" ? "darwin" : "linux";
  const arch = p.arch === "aarch64" ? "arm64" : "x64";
  const ext = p.os === "darwin" ? "zip" : "tar.gz";
  return {
    url: `https://github.com/anomalyco/opencode/releases/download/${OPENCODE_VERSION}/opencode-${os}-${arch}.${ext}`,
    extractedBinary: "opencode",
  };
}

function extractExtraArgs(argv: string[]): string[] {
  const dashIdx = argv.indexOf("--");
  return dashIdx >= 0 ? argv.slice(dashIdx + 1) : [];
}

function resolveRunOptions(
  argv: { [key: string]: unknown },
  processArgv: string[],
): { extra: string[]; useNightshiftTui: boolean; sandboxEnabled: boolean } {
  return {
    extra: extractExtraArgs(processArgv),
    useNightshiftTui: Boolean(argv["run-nightshift-tui"]),
    sandboxEnabled: Boolean(argv["sandbox"]),
  };
}

function buildAttachTuiArgs(url: string, session: string | undefined, directory: string): {
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

function buildXdgEnv(prefix: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: join(prefix, "config"),
    XDG_DATA_HOME: join(prefix, "share"),
    XDG_CACHE_HOME: join(prefix, "cache"),
    XDG_STATE_HOME: join(prefix, "state"),
  };
}

async function checkSandboxAvailability(): Promise<{ available: boolean; reason?: string }> {
  if (process.platform === "darwin") {
    // macOS has sandbox-exec built-in
    return { available: true };
  }

  if (process.platform === "linux") {
    // Check if bwrap is available in PATH
    const proc = Bun.spawn(["which", "bwrap"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      return { available: true };
    }
    return {
      available: false,
      reason: "bwrap (bubblewrap) not found in PATH. Install it with: apt install bubblewrap (Debian/Ubuntu) or dnf install bubblewrap (Fedora)",
    };
  }

  return {
    available: false,
    reason: "Sandbox is not supported on this platform",
  };
}

function pythonUrl(p: Platform): { url: string; extractedBinary: string } {
  const triple =
    p.os === "darwin"
      ? `${p.arch}-apple-darwin`
      : `${p.arch}-unknown-linux-gnu`;
  const encoded = `cpython-${PYTHON_VERSION}%2B${PYTHON_RELEASE}-${triple}-install_only.tar.gz`;
  return {
    url: `https://github.com/indygreg/python-build-standalone/releases/download/${PYTHON_RELEASE}/${encoded}`,
    extractedBinary: "python/bin/python3",
  };
}

function uvUrl(p: Platform): { url: string; extractedBinary: string } {
  const triple =
    p.os === "darwin"
      ? `${p.arch}-apple-darwin`
      : `${p.arch}-unknown-linux-gnu`;
  return {
    url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-${triple}.tar.gz`,
    extractedBinary: `uv-${triple}/uv`,
  };
}

function ripgrepUrl(p: Platform): { url: string; extractedBinary: string } {
  const triple =
    p.os === "darwin"
      ? `${p.arch}-apple-darwin`
      : p.arch === "x86_64"
        ? `x86_64-unknown-linux-musl`
        : `aarch64-unknown-linux-gnu`;
  return {
    url: `https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-${triple}.tar.gz`,
    extractedBinary: `ripgrep-${RIPGREP_VERSION}-${triple}/rg`,
  };
}


async function download(url: string, dest: string): Promise<void> {
  console.log(`  Downloading ${url}`);
  const proc = Bun.spawn(["curl", "-fSL", "-o", dest, url], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Failed to download ${url} (curl exit ${exitCode})`);
  console.log(`  Saved to ${dest}`);
}


async function extract(archive: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  if (archive.endsWith(".zip")) {
    const proc = Bun.spawn(["unzip", "-o", archive, "-d", destDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`unzip failed (${exitCode}): ${err}`);
    }
  } else {
    // tar.gz or tar.xz
    const proc = Bun.spawn(["tar", "xf", archive, "-C", destDir], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const err = await new Response(proc.stderr).text();
      throw new Error(`tar failed (${exitCode}): ${err}`);
    }
  }
  console.log(`  Extracted to ${destDir}`);
}


interface BinaryMapping {
  /** Name of the symlink in bin/ */
  linkName: string;
  /** Path to the real binary relative to tools/<name>/ */
  target: string;
}

async function installTool(
  name: string,
  url: string,
  prefix: string,
  binaryMappings: BinaryMapping[],
): Promise<void> {
  console.log(`\nInstalling ${name}...`);
  const toolsDir = join(prefix, "tools", name);
  const binDir = join(prefix, "bin");
  mkdirSync(toolsDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const archiveName = url.split("/").pop()!;
  const archivePath = join(prefix, "tools", archiveName);

  await download(url, archivePath);
  await extract(archivePath, toolsDir);

  // Create symlinks
  for (const mapping of binaryMappings) {
    const linkPath = join(binDir, mapping.linkName);
    const targetAbsolute = join(toolsDir, mapping.target);

    if (!existsSync(targetAbsolute)) {
      console.warn(`  Warning: binary not found at ${targetAbsolute}`);
      continue;
    }

    // Ensure executable
    chmodSync(targetAbsolute, 0o755);

    // Create relative symlink
    const relTarget = relative(binDir, targetAbsolute);
    if (existsSync(linkPath)) {
      const { unlinkSync } = await import("fs");
      unlinkSync(linkPath);
    }
    symlinkSync(relTarget, linkPath);
    console.log(`  Linked ${mapping.linkName} → ${relTarget}`);
  }

  // Clean up archive
  const { unlinkSync } = await import("fs");
  unlinkSync(archivePath);
}


function generateRootPyproject(libraryName: string, packages: string[]): string {
  const depsStr = packages.map((p) => `    "${p}",`).join("\n");
  const snakeName = libraryName.replace(/-/g, "_");
  return `[project]
name = "${libraryName}"
version = "0.1.0"
description = "Agent-maintained Python library"
requires-python = ">=3.11"
dependencies = [
${depsStr}
]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/${snakeName}"]

[tool.uv]
dev-dependencies = ["pytest>=8.0.0"]
`;
}

function generateUtilsPy(libraryName: string): string {
  return `"""Utility functions for ${libraryName}."""
import numpy as np
import pandas as pd


def hello() -> str:
    return "Hello from ${libraryName}!"


def create_sample_dataframe() -> pd.DataFrame:
    return pd.DataFrame({"x": np.arange(10), "y": np.random.randn(10)})
`;
}

function generateTestUtilsPy(libraryName: string): string {
  const snakeName = libraryName.replace(/-/g, "_");
  return `from ${snakeName}.utils import hello, create_sample_dataframe


def test_hello():
    assert hello() == "Hello from ${libraryName}!"


def test_create_sample_dataframe():
    df = create_sample_dataframe()
    assert len(df) == 10
`;
}

function generateReadme(libraryName: string): string {
  return `# ${libraryName}

Agent-maintained Python library for data science workflows.

## Usage

\`\`\`python
from ${libraryName.replace(/-/g, "_")}.utils import hello, create_sample_dataframe

print(hello())
df = create_sample_dataframe()
\`\`\`

## Running Tests

\`\`\`bash
pytest
\`\`\`
`;
}

function generateOpencodeConfig(): string {
  return JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    "permission": {
      "edit": "ask",
      "bash": "ask",
      "webfetch": "allow",
      "write": "allow",
      "codesearch": "allow",
      "read": "allow",
      "grep": "ask",
      "glob": "allow",
      "list": "allow",
      "lsp": "allow",
      "skill": "allow",
      "todowrite": "allow",
      "todoread": "allow",
      "question": "allow"
    },
    "plugin": ["@processmesh-plugins/email"]
  }, null, 2);
}

function generateAgentsMd(libraryName: string): string {
  const snakeName = libraryName.replace(/-/g, "_");
  return `# Agent Instructions

You are a data scientist serving business users. Your users do not care about code—they care about **results**. Deliver insights, not implementation details.

## Identity

- Expert Python developer maintaining **one codebase**: this workspace
- Write code as a library author in \`src/${snakeName}/\`
- Consume that library in scripts and notebooks
- Prioritize: maintainability, simplicity, long-term sustainability

## Commands

\`\`\`bash
# Type check (always before committing)
ty check

# Run tests
uv run pytest

# Run a script
uv run python <script.py>

# Add dependencies
uv add <package>
uv add --dev <package>

# Sync environment
uv sync
\`\`\`

## Git Workflow

Commit small, atomic units of work:

\`\`\`bash
ty check && git add <files> && git commit -m "<message>"
\`\`\`

Each commit must:
1. Pass \`ty check\`
2. Be a single logical change
3. Have a descriptive message

## Code Style

- Type hints on all function signatures
- Docstrings only when behavior is non-obvious
- Small, focused functions
- Explicit over implicit

## Project Structure

\`\`\`
pyproject.toml        # Dependencies (use uv, never pip)
src/${snakeName}/     # Library code (reusable, tested)
tests/                # Tests for library code
.venv/                # Virtual environment (managed by uv)
\`\`\`

## Boundaries

### Always

- Type check with \`ty check\` before committing
- Commit in small, logical units
- Deliver results, not code explanations
- Keep it simple

### Ask First

- Adding new dependencies
- Changing project structure

### Never

- Commit code that fails \`ty check\`
- Use \`pip install\` (use \`uv add\`)
- Activate venv manually (use \`uv run\`)
- Over-engineer for hypothetical needs
- Explain code to users—give them results
`;
}

interface ScaffoldOptions {
  skipAgentsMd?: boolean;
}

async function createWorkspaceScaffold(
  workspacePath: string,
  libraryName: string,
  packages: string[],
  options: ScaffoldOptions = {},
): Promise<void> {
  console.log(`\nCreating workspace scaffold at ${workspacePath}...`);
  const snakeName = libraryName.replace(/-/g, "_");
  const srcDir = join(workspacePath, "src", snakeName);
  const testsDir = join(workspacePath, "tests");

  mkdirSync(srcDir, { recursive: true });
  mkdirSync(testsDir, { recursive: true });

  await Bun.write(join(workspacePath, "pyproject.toml"), generateRootPyproject(libraryName, packages));
  await Bun.write(join(srcDir, "__init__.py"), `"""${libraryName} package."""\n`);
  await Bun.write(join(srcDir, "utils.py"), generateUtilsPy(libraryName));
  await Bun.write(join(testsDir, "__init__.py"), "");
  await Bun.write(join(testsDir, "test_utils.py"), generateTestUtilsPy(libraryName));
  await Bun.write(join(workspacePath, "README.md"), generateReadme(libraryName));
  if (!options.skipAgentsMd) {
    await Bun.write(join(workspacePath, "AGENTS.md"), generateAgentsMd(libraryName));
  }
  await Bun.write(join(workspacePath, "opencode.json"), generateOpencodeConfig());

  console.log(`  Created workspace scaffold with library "${libraryName}"`);
}

async function syncWorkspace(prefix: string, workspacePath: string): Promise<void> {
  console.log(`\nSyncing workspace dependencies...`);
  const uv = join(prefix, "bin", "uv");

  const proc = Bun.spawn([uv, "sync"], {
    cwd: workspacePath,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Workspace sync failed (${exitCode})`);
  console.log("  Workspace synced successfully.");
}

async function installUvTools(prefix: string): Promise<void> {
  console.log(`\nInstalling uv tools...`);
  const uv = join(prefix, "bin", "uv");
  const toolDir = join(prefix, "uv-tools");
  const toolBinDir = join(prefix, "uv-tools", "bin");

  const proc = Bun.spawn([uv, "tool", "install", "ty"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
      UV_TOOL_DIR: toolDir,
      UV_TOOL_BIN_DIR: toolBinDir,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`uv tool install failed (${exitCode})`);
  console.log("  ty installed successfully.");
}


function buildPath(prefix: string): string {
  const binDir = join(prefix, "bin");
  const uvToolsBin = join(prefix, "uv-tools", "bin");
  let pathParts = [binDir];
  if (existsSync(uvToolsBin)) pathParts.unshift(uvToolsBin);
  return `${pathParts.join(":")}:${process.env.PATH ?? ""}`;
}


async function waitForServer(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(`${url}/global/health`);
      if (response.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Server failed to start within timeout");
}


function buildBootstrapPrompt(userIntent: string): string {
  return `
You are bootstrapping a new workspace for the user. Their stated purpose is:
"${userIntent}"

## Important: Interview the User

Before taking any action, interview the user extensively to understand their needs:
- What specific problems are they trying to solve?
- What data sources will they work with?
- What are their preferred tools or libraries?
- What is their experience level with Python?
- Any specific requirements or constraints?

Use the AskUserQuestion tool to gather this information. Ask 2-4 focused questions before proceeding.

## After gathering information:

1. **Install packages**: Run \`uv add <packages>\` to install Python libraries appropriate for this use case
2. **Create library structure**: Add modules to src/agent_lib/ that will help with the stated purpose
3. **Generate AGENTS.md**: Create an AGENTS.md file following these best practices:

## AGENTS.md Guidelines (keep under 150 lines):

### Required Sections:
- **Project Overview**: One-sentence description tailored to "${userIntent}"
- **Commands**: Exact commands for build, test, run (use bun, uv, pytest)
- **Tech Stack**: Python 3.13, Bun, uv, and installed packages
- **Project Structure**: Key file paths and their purposes
- **Code Style**: Formatting rules, design patterns (use ruff, black)
- **Do's and Don'ts**: Specific, actionable guidelines for this use case
- **Safety Boundaries**:
  - Always do: Read files, run tests, format code
  - Ask first: Install new packages, modify pyproject.toml
  - Never do: Delete data, run destructive commands

### Style Guidelines:
- Be specific, not vague
- Use code examples, not descriptions
- Make commands copy-pasteable
- Prioritize capabilities over file structure
`.trim();
}


// Types for tool completion handling
type ToolCompletionPart = {
  tool: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    metadata?: Record<string, unknown>;
    title?: string;
  };
  id: string;
};

function handleToolCompletion(
  ui: import("./bootstrap-prompt").BootstrapUI,
  part: ToolCompletionPart,
): void {
  const { state, tool } = part;
  const output = state.output;
  const input = state.input;
  const metadata = state.metadata;
  const title = state.title || tool;

  if (tool === "bash" && output?.trim()) {
    const command = (input?.command as string) || title;
    const description = input?.description as string | undefined;
    ui.showBashOutput(command, output, description);
  } else if (tool === "write" && input?.filePath) {
    ui.showWriteOutput(input.filePath as string, (input.content as string) || "");
  } else if (tool === "edit" && metadata?.diff && input?.filePath) {
    // edit tool: single file, filePath in input
    ui.showEditOutput(input.filePath as string, metadata.diff as string);
  } else if (tool === "apply_patch" && metadata?.diff) {
    // apply_patch: multiple files, extract paths from metadata.files or use title
    const files = metadata.files as Array<{ filePath?: string; relativePath?: string }> | undefined;
    const filePath = files?.map(f => f.relativePath || f.filePath).join(", ") || title;
    ui.showEditOutput(filePath, metadata.diff as string);
  } else {
    ui.appendToolStatus("completed", title);
  }
}

async function autoApprovePermission(
  client: import("@opencode-ai/sdk/v2").OpencodeClient,
  ui: import("./bootstrap-prompt").BootstrapUI,
  request: { id: string; permission: string; metadata?: Record<string, unknown>; patterns?: string[] },
): Promise<void> {
  const description = (request.metadata?.description as string) || (request.metadata?.filepath as string) || request.patterns?.[0] || "";
  ui.appendText(`[Auto-approving ${request.permission}${description ? `: ${description}` : ""}]\n`);
  await client.permission.reply({ requestID: request.id, reply: "once" });
}

async function bootstrapWithOpencode(
  prefix: string,
  workspacePath: string,
  userIntent: string,
  xdgEnv: Record<string, string>,
  ui: import("./bootstrap-prompt").BootstrapUI,
  client: import("@opencode-ai/sdk/v2").OpencodeClient,
  url: string,
  model?: { providerID: string; modelID: string },
): Promise<void> {
  ui.setStatus("Sending bootstrap prompt...");

  const abort = new AbortController();

  try {

    // Create session
    const session = await client.session.create({ title: "Bootstrap" });
    if (!session.data) {
      throw new Error("Failed to create session");
    }
    const sessionId = session.data.id;

    // Track tool states to avoid duplicate output
    const toolStates = new Map<string, string>();

    // Set up event handling for permissions and streaming output
    const sessionComplete = new Promise<void>((resolve, reject) => {
      (async () => {
        try {
          const events = await client.event.subscribe({}, { signal: abort.signal });

          for await (const event of events.stream) {
            // Auto-approve all permission requests during bootstrap
            // TODO: we should not do this
            if (event.type === "permission.asked") {
              const request = event.properties;
              if (request.sessionID === sessionId) {
                await autoApprovePermission(client, ui, request);
              }
            }

            // Stream text output
            if (event.type === "message.part.updated") {
              const { part, delta } = event.properties;
              if (part.sessionID !== sessionId) continue;

              // Stream text deltas
              if (part.type === "text" && delta) {
                ui.appendText(delta);
              }

              // Show tool execution status
              if (part.type === "tool") {
                const prevState = toolStates.get(part.id);
                const currentState = part.state.status;

                if (prevState !== currentState) {
                  toolStates.set(part.id, currentState);
                  const title = (part.state as any).title || part.tool;

                  if (currentState === "running") {
                    ui.setStatus(`Running: ${title}`);
                    ui.appendToolStatus("running", title);
                  } else if (currentState === "completed") {
                    handleToolCompletion(ui, {
                      tool: part.tool,
                      state: part.state as ToolCompletionPart["state"],
                      id: part.id,
                    });
                  } else if (currentState === "error") {
                    const error = (part.state as any).error || "Unknown error";
                    ui.appendToolStatus("error", `${title}: ${error}`);
                  }
                }
              }
            }

            // Handle session diffs (file changes)
            if (event.type === "session.diff") {
              const { sessionID, diff } = event.properties;
              if (sessionID === sessionId && diff && diff.length > 0) {
                ui.showDiff(diff);
              }
            }

            // Handle question events
            if (event.type === "question.asked") {
              const request = event.properties;
              if (request.sessionID === sessionId) {
                try {
                  const answers = await ui.showQuestion(request);
                  await client.question.reply({
                    requestID: request.id,
                    answers,
                  });
                } catch (err) {
                  // User rejected/cancelled the question
                  await client.question.reject({
                    requestID: request.id,
                  });
                }
              }
            }

            // Check if session is idle (completed)
            if (event.type === "session.idle" && event.properties.sessionID === sessionId) {
              resolve();
              return;
            }

            // Handle session errors
            if (event.type === "session.error" && (event.properties as any).sessionID === sessionId) {
              reject(new Error(`Session error: ${JSON.stringify(event.properties)}`));
              return;
            }
          }
        } catch (err) {
          if (!abort.signal.aborted) {
            reject(err);
          }
        }
      })();
    });

    // Send bootstrap prompt asynchronously
    const prompt = buildBootstrapPrompt(userIntent);
    await client.session.promptAsync({
      sessionID: sessionId,
      model: model,
      parts: [{ type: "text", text: prompt }],
    });

    const timeout = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("Bootstrap timed out after 5 minutes")), 5 * 60 * 1000);
    });

    // Wait for session to complete...timeout after 5 minutes
    await Promise.race([sessionComplete, timeout]);

    ui.setStatus("Bootstrap complete!");
  } finally {
    abort.abort();
  }
}


async function install(prefix: string): Promise<void> {
  prefix = resolve(prefix);
  console.log(`Installing nightshift tools to ${prefix}`);

  const platform = detectPlatform();
  console.log(`Detected platform: ${platform.os} / ${platform.arch}`);

  const py = pythonUrl(platform);
  await installTool("python", py.url, prefix, [
    { linkName: "python3", target: py.extractedBinary },
    { linkName: "python", target: py.extractedBinary },
  ]);

  const uv = uvUrl(platform);
  await installTool("uv", uv.url, prefix, [
    { linkName: "uv", target: uv.extractedBinary },
  ]);

  const rg = ripgrepUrl(platform);
  await installTool("ripgrep", rg.url, prefix, [
    { linkName: "rg", target: rg.extractedBinary },
  ]);

  const oc = opencodeUrl(platform);
  await installTool("opencode", oc.url, prefix, [
    { linkName: "opencode", target: oc.extractedBinary },
  ]);

  await installUvTools(prefix);

  // Create workspace scaffold
  const config = await readFullConfig(process.cwd());
  const workspacePath = config?.workspacePath
    ? resolve(expandHome(config.workspacePath))
    : join(prefix, "workspace");
  const libraryName = config?.libraryName ?? "agent_lib";
  const packages = config?.workspacePackages ?? WORKSPACE_PACKAGES;

  // Create XDG directories for isolated opencode config/data/cache/state
  const xdgDirs = ["config", "share", "cache", "state"];
  for (const dir of xdgDirs) {
    mkdirSync(join(prefix, dir), { recursive: true });
  }

  const xdgEnv = buildXdgEnv(prefix);

  const isNewWorkspace = !existsSync(workspacePath);

  if (isNewWorkspace) {
    // Create scaffold without AGENTS.md - that will be generated by opencode
    await createWorkspaceScaffold(workspacePath, libraryName, packages, { skipAgentsMd: true });
    await syncWorkspace(prefix, workspacePath);

    try {
      const result = await runBootstrapPrompt(
        async (userIntent, ui, client, serverUrl, model) => {
          await bootstrapWithOpencode(prefix, workspacePath, userIntent, xdgEnv, ui, client, serverUrl, model);
        },
        {
          prefix,
          workspacePath,
          xdgEnv,
        }
      );

      if (!result) {
        // User skipped (Ctrl+C)
        console.log("\nSkipped bootstrap. Using default AGENTS.md.");
        await Bun.write(join(workspacePath, "AGENTS.md"), generateAgentsMd(libraryName));
      } else {
        // Kill the server process after bootstrap
        result.serverProc.kill();
      }
    } catch (err) {
      console.error("\nBootstrap failed:", err);
      console.log("Falling back to default AGENTS.md.");
      await Bun.write(join(workspacePath, "AGENTS.md"), generateAgentsMd(libraryName));
    }
  } else {
    console.log(`\nWorkspace already exists at ${workspacePath}`);
  }

  // Save active prefix for future runs
  await saveActivePrefix(prefix);

  console.log("\nInstallation complete!");
  console.log(`  Prefix: ${prefix}`);
  console.log(`  Workspace: ${workspacePath}`);
  console.log(`  Run: bun ${__filename} run`);
}


async function run(prefix: string, args: string[], useNightshiftTui: boolean, sandboxEnabled: boolean): Promise<void> {
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

  // Add workspace src to PYTHONPATH
  const workspaceSrc = join(workspacePath, "src");
  const PYTHONPATH = existsSync(workspaceSrc)
    ? `${workspaceSrc}:${process.env.PYTHONPATH ?? ""}`
    : process.env.PYTHONPATH ?? "";

  const xdgEnv = buildXdgEnv(prefix);

  // Build sandbox options
  const sandboxOpts: SandboxOptions = {
    workspacePath,
    prefixPath: prefix,
    binDir,
    env: {
      ...xdgEnv,
      PATH,
      PYTHONPATH,
      HOME: process.env.HOME ?? "",
      USER: process.env.USER ?? "",
      TERM: process.env.TERM ?? "xterm-256color",
      LANG: process.env.LANG ?? "en_US.UTF-8",
      OPENCODE_EXPERIMENTAL_LSP_TY: "true",
    },
  };

  if (useNightshiftTui) {
    // Start opencode as a server and attach nightshift TUI
    await runWithNightshiftTui(opencode, PATH, PYTHONPATH, workspacePath, args, xdgEnv, sandboxEnabled, sandboxOpts);
  } else {
    // Standard opencode execution
    console.log(`Launching opencode with isolated PATH`);
    console.log(`  PATH prefix: ${pathParts.join(":")}`);
    if (existsSync(workspaceSrc)) {
      console.log(`  PYTHONPATH includes: ${workspaceSrc}`);
    }

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
        PATH,
        PYTHONPATH,
        OPENCODE_EXPERIMENTAL_LSP_TY: "true",
      },
    });

    const exitCode = await proc.exited;
    process.exit(exitCode);
  }
}

async function runWithNightshiftTui(opencodePath: string, PATH: string, PYTHONPATH: string, workspacePath: string, _args: string[], xdgEnv: Record<string, string>, sandboxEnabled: boolean, sandboxOpts: SandboxOptions): Promise<void> {
  // Find an available port
  const port = 4096 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;

  console.log(`Starting opencode server on port ${port}...`);

  // Build server command
  const baseServerCommand = [opencodePath, "serve", "--port", String(port)];
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
      PATH,
      PYTHONPATH,
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
  const { tui } = await import("./cli/cmd/tui/tui/app");

  try {
    await tui({ url, args: {}, directory: workspacePath });
  } finally {
    // Clean up server when TUI exits
    serverProc.kill();
  }
}


export {
  detectPlatform,
  configSearchPaths,
  expandHome,
  resolvePrefixFromConfig,
  readFullConfig,
  saveActivePrefix,
  opencodeUrl,
  pythonUrl,
  uvUrl,
  ripgrepUrl,
  extractExtraArgs,
  resolveRunOptions,
  buildAttachTuiArgs,
  buildXdgEnv,
  buildPath,
  buildBootstrapPrompt,
  waitForServer,
  generateRootPyproject,
  generateUtilsPy,
  generateTestUtilsPy,
  generateReadme,
  generateAgentsMd,
  generateOpencodeConfig,
  checkSandboxAvailability,
  handleToolCompletion,
  WORKSPACE_PACKAGES,
};

export type { ToolCompletionPart };

if (import.meta.main) {
  yargs(process.argv.slice(2))
    .command(
      "install",
      "Install opencode + tools into a prefix",
      (y) =>
        y.option("prefix", {
          type: "string",
          demandOption: true,
          describe: "Directory to install tools into",
        }),
      async (argv) => {
        try {
          await install(argv.prefix);
        } catch (err) {
          console.error("Install failed:", err);
          process.exit(1);
        }
      },
    )
    .command(
      "run",
      "Launch opencode with isolated env",
      (y) =>
        y
          .option("prefix", {
            type: "string",
            describe: "Prefix where tools are installed (defaults to nightshift.json)",
          })
          .option("run-nightshift-tui", {
            type: "boolean",
            default: false,
            describe: "Use Nightshift TUI instead of default opencode",
          })
          .option("sandbox", {
            type: "boolean",
            default: false,
            describe: "Run in sandbox mode (read-only host filesystem, writable workspace)",
          }),
      async (argv) => {
        try {
          const { extra, useNightshiftTui, sandboxEnabled } = resolveRunOptions(argv, process.argv);
          if (argv.prefix) {
            await saveActivePrefix(argv.prefix);
            await run(argv.prefix, extra, useNightshiftTui, sandboxEnabled);
            return;
          }

          const resolved = await resolvePrefixFromConfig(process.cwd());
          console.log(`Using prefix from ${resolved.source}`);
          await run(resolved.prefix, extra, useNightshiftTui, sandboxEnabled);
        } catch (err) {
          console.error("Run failed:", err);
          process.exit(1);
        }
      },
    )
    .command(
      "$0",
      "Launch opencode using nightshift.json",
      (y) =>
        y
          .option("run-nightshift-tui", {
            type: "boolean",
            default: false,
            describe: "Use Nightshift TUI instead of default opencode",
          })
          .option("sandbox", {
            type: "boolean",
            default: false,
            describe: "Run in sandbox mode (read-only host filesystem, writable workspace)",
          }),
      async (argv) => {
        try {
          const { extra, useNightshiftTui, sandboxEnabled } = resolveRunOptions(argv, process.argv);
          const resolved = await resolvePrefixFromConfig(process.cwd());
          console.log(`Using prefix from ${resolved.source}`);
          await run(resolved.prefix, extra, useNightshiftTui, sandboxEnabled);
        } catch (err) {
          console.error("Run failed:", err);
          process.exit(1);
        }
      }
    )
    .command(
      "attach <url>",
      "Attach to a running opencode server",
      (y) =>
        y
          .positional("url", {
            type: "string",
            demandOption: true,
            describe: "URL of the opencode server (e.g., http://localhost:4096)",
          })
          .option("session", {
            alias: "s",
            type: "string",
            describe: "Session ID to continue",
          }),
      async (argv) => {
        try {
          const { tui } = await import("./cli/cmd/tui/tui/app");
          await tui(buildAttachTuiArgs(argv.url!, argv.session, process.cwd()));
        } catch (err) {
          console.error("Attach failed:", err);
          process.exit(1);
        }
      },
    )
    .demandCommand(1, "Please specify a command: install, run, or attach")
    .strict()
    .help()
    .parse();
}

import yargs from "yargs";
import { resolve, join, relative } from "path";
import { homedir } from "os";
import { mkdirSync, symlinkSync, existsSync, chmodSync } from "fs";

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
): { extra: string[]; useNightshiftTui: boolean } {
  return {
    extra: extractExtraArgs(processArgv),
    useNightshiftTui: Boolean(argv["run-nightshift-tui"]),
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
    }
  }, null, 2);
}

function generateAgentsMd(libraryName: string): string {
  const snakeName = libraryName.replace(/-/g, "_");
  return `# Nightshift Workspace

This is a Python data science workspace managed by Nightshift.

## Python Package Management

This workspace uses **uv** for Python package management. Do NOT use pip directly.

### Common uv Commands

- **Add a dependency**: \`uv add <package>\`
- **Add a dev dependency**: \`uv add --dev <package>\`
- **Sync/install dependencies**: \`uv sync\`
- **Run Python scripts**: \`uv run python <script.py>\`
- **Run pytest**: \`uv run pytest\`

### Important Notes

- The virtual environment is at \`.venv/\`
- Dependencies are defined in \`pyproject.toml\`
- Never use \`pip install\` - use \`uv add\` instead
- Never activate the venv manually - use \`uv run\` to execute commands

## Project Structure

\`\`\`
pyproject.toml      # Project metadata and dependencies
src/${snakeName}/   # Library source code
  __init__.py
  utils.py
tests/              # Test files
  test_utils.py
.venv/              # Virtual environment (managed by uv)
\`\`\`
`;
}

async function createWorkspaceScaffold(
  workspacePath: string,
  libraryName: string,
  packages: string[],
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
  await Bun.write(join(workspacePath, "AGENTS.md"), generateAgentsMd(libraryName));
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

  if (!existsSync(workspacePath)) {
    await createWorkspaceScaffold(workspacePath, libraryName, packages);
    await syncWorkspace(prefix, workspacePath);
  }

  // Save active prefix for future runs
  await saveActivePrefix(prefix);

  console.log("Installation complete!");
  console.log(`  Prefix: ${prefix}`);
  console.log(`  Workspace: ${workspacePath}`);
  console.log(`  Run: bun ${__filename} run`);
}


async function run(prefix: string, args: string[], useNightshiftTui: boolean): Promise<void> {
  prefix = resolve(prefix);
  const binDir = join(prefix, "bin");
  const uvToolsBin = join(prefix, "uv-tools", "bin");
  const opencode = join(binDir, "opencode");

  if (!existsSync(opencode)) {
    throw new Error(`opencode not found at ${opencode}. Run install first.`);
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

  if (useNightshiftTui) {
    // Start opencode as a server and attach nightshift TUI
    await runWithNightshiftTui(opencode, PATH, PYTHONPATH, workspacePath, args);
  } else {
    // Standard opencode execution
    console.log(`Launching opencode with isolated PATH`);
    console.log(`  PATH prefix: ${pathParts.join(":")}`);
    if (existsSync(workspaceSrc)) {
      console.log(`  PYTHONPATH includes: ${workspaceSrc}`);
    }

    const proc = Bun.spawn([opencode, ...args], {
      cwd: workspacePath,
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: {
        ...process.env,
        PATH,
        PYTHONPATH,
        OPENCODE_EXPERIMENTAL_LSP_TY: "true",
      },
    });

    const exitCode = await proc.exited;
    process.exit(exitCode);
  }
}

async function runWithNightshiftTui(opencodePath: string, PATH: string, PYTHONPATH: string, workspacePath: string, _args: string[]): Promise<void> {
  // Find an available port
  const port = 4096 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;

  console.log(`Starting opencode server on port ${port}...`);

  // Start opencode as a server
  const serverProc = Bun.spawn([opencodePath, "serve", "--port", String(port)], {
    cwd: workspacePath,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
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
    await tui({ url, args: {}, directory: process.cwd() });
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
  generateRootPyproject,
  generateUtilsPy,
  generateTestUtilsPy,
  generateReadme,
  generateAgentsMd,
  generateOpencodeConfig,
  WORKSPACE_PACKAGES,
};

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
          }),
      async (argv) => {
        try {
          const { extra, useNightshiftTui } = resolveRunOptions(argv, process.argv);
          if (argv.prefix) {
            await saveActivePrefix(argv.prefix);
            await run(argv.prefix, extra, useNightshiftTui);
            return;
          }

          const resolved = await resolvePrefixFromConfig(process.cwd());
          console.log(`Using prefix from ${resolved.source}`);
          await run(resolved.prefix, extra, useNightshiftTui);
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

        y.option("run-nightshift-tui", {
          type: "boolean",
          default: false,
          describe: "Use Nightshift TUI instead of default opencode",
        }),
      async (argv) => {
        try {
          const { extra, useNightshiftTui } = resolveRunOptions(argv, process.argv);
          const resolved = await resolvePrefixFromConfig(process.cwd());
          console.log(`Using prefix from ${resolved.source}`);
          await run(resolved.prefix, extra, useNightshiftTui);
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

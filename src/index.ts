import yargs from "yargs";
import { resolve, join, relative, dirname } from "path";
import { homedir } from "os";
import { mkdirSync, symlinkSync, existsSync, chmodSync } from "fs";

const OPENCODE_VERSION = "v1.1.37"
const PYTHON_VERSION = "3.13.11";
const PYTHON_RELEASE = "20260127";
const UV_VERSION = "0.9.27";
const RIPGREP_VERSION = "15.1.0";

const DATA_SCIENCE_PACKAGES = ["numpy", "pandas"];

interface Platform {
  os: "darwin" | "linux";
  arch: "x86_64" | "aarch64";
}

interface NightshiftConfig {
  activePrefix?: string;
  prefix?: string;
}

function detectPlatform(): Platform {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return { os, arch };
}

function configSearchPaths(cwd: string): string[] {
  const paths = [join(cwd, "nightshift.json")];
  const home = homedir();
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


function opencodeUrl(p: Platform): { url: string; extractedBinary: string } {
  const os = p.os === "darwin" ? "darwin" : "linux";
  const arch = p.arch === "aarch64" ? "arm64" : "x64";
  const ext = p.os === "darwin" ? "zip" : "tar.gz";
  return {
    url: `https://github.com/anomalyco/opencode/releases/download/${OPENCODE_VERSION}/opencode-${os}-${arch}.${ext}`,
    extractedBinary: "opencode",
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


async function createVenv(prefix: string): Promise<void> {
  console.log("\nCreating data-science venv...");
  const python = join(prefix, "bin", "python3");
  const venvPath = join(prefix, "venvs", "data-science");
  mkdirSync(dirname(venvPath), { recursive: true });


  const proc = Bun.spawn([python, "-m", "venv", venvPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`venv creation failed (${exitCode})`);
  console.log(`  Venv created at ${venvPath}`);
}


async function installPackages(prefix: string, packages: string[]): Promise<void> {
  console.log(`\nInstalling packages: ${packages.join(", ")}...`);
  const uv = join(prefix, "bin", "uv");
  const venvPython = join(prefix, "venvs", "data-science", "bin", "python3");

  const proc = Bun.spawn([uv, "pip", "install", "--python", venvPython, ...packages], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      PATH: `${join(prefix, "bin")}:${process.env.PATH}`,
    },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) throw new Error(`Package install failed (${exitCode})`);
  console.log("  Packages installed successfully.");
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

  await createVenv(prefix);
  await installPackages(prefix, DATA_SCIENCE_PACKAGES);

  console.log("Installation complete!");
  console.log(`  Prefix: ${prefix}`);
  console.log(`  Run: bun ${__filename} run --prefix ${prefix}`);
}


async function run(prefix: string, args: string[], useNightshiftTui: boolean): Promise<void> {
  prefix = resolve(prefix);
  const binDir = join(prefix, "bin");
  const venvBin = join(prefix, "venvs", "data-science", "bin");
  const opencode = join(binDir, "opencode");

  if (!existsSync(opencode)) {
    throw new Error(`opencode not found at ${opencode}. Run install first.`);
  }

  const PATH = `${venvBin}:${binDir}:${process.env.PATH ?? ""}`;
  if (useNightshiftTui) {
    // Start opencode as a server and attach nightshift TUI
    await runWithNightshiftTui(opencode, PATH, args);
  } else {
    // Standard opencode execution
    console.log(`Launching opencode with isolated PATH`);
    console.log(`  PATH prefix: ${venvBin}:${binDir}`);

    const proc = Bun.spawn([opencode, ...args], {
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: {
        ...process.env,
        PATH,
      },
    });

    const exitCode = await proc.exited;
    process.exit(exitCode);
  }
}

async function runWithNightshiftTui(opencodePath: string, PATH: string, _args: string[]): Promise<void> {
  // Find an available port
  const port = 4096 + Math.floor(Math.random() * 1000);
  const url = `http://127.0.0.1:${port}`;

  console.log(`Starting opencode server on port ${port}...`);

  // Start opencode as a server
  const serverProc = Bun.spawn([opencodePath, "serve", "--port", String(port)], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      PATH,
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
  opencodeUrl,
  pythonUrl,
  uvUrl,
  ripgrepUrl,
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
          const dashIdx = process.argv.indexOf("--");
          const extra = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];
          const useNightshiftTui = Boolean(argv["run-nightshift-tui"]);
          if (argv.prefix) {
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
          const dashIdx = process.argv.indexOf("--");
          const extra = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];
          const resolved = await resolvePrefixFromConfig(process.cwd());
          console.log(`Using prefix from ${resolved.source}`);
          await run(resolved.prefix, extra, Boolean(argv["run-nightshift-tui"]));
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
          await tui({
            url: argv.url!,
            args: { sessionID: argv.session },
            directory: process.cwd(),
          });
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

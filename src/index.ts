import yargs from "yargs";
import { resolve, join, relative, dirname } from "path";
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

function detectPlatform(): Platform {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return { os, arch };
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


async function run(prefix: string, args: string[]): Promise<void> {
  debugger;
  prefix = resolve(prefix);
  const binDir = join(prefix, "bin");
  const venvBin = join(prefix, "venvs", "data-science", "bin");
  const opencode = join(binDir, "opencode");

  if (!existsSync(opencode)) {
    throw new Error(`opencode not found at ${opencode}. Run install first.`);
  }

  const PATH = `${venvBin}:${binDir}:${process.env.PATH ?? ""}`;

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
      y.option("prefix", {
        type: "string",
        demandOption: true,
        describe: "Prefix where tools are installed",
      }),
    async (argv) => {
      try {
        const dashIdx = process.argv.indexOf("--");
        const extra = dashIdx >= 0 ? process.argv.slice(dashIdx + 1) : [];
        await run(argv.prefix, extra);
      } catch (err) {
        console.error("Run failed:", err);
        process.exit(1);
      }
    },
  )
  .demandCommand(1, "Please specify a command: install or run")
  .strict()
  .help()
  .parse();
